import type { Peer, Message } from 'crossws'
import { eq, inArray, desc } from 'drizzle-orm'
import { db } from '~/db'
import { blackCards, whiteCards, gameSessions, gameRounds } from '~/db/schema'
import { wsLogger } from '~/lib/logger'
import { captureServerEvent } from '~/lib/posthog-server'
import { authenticateSocket } from './auth'
import { redis, getSubscriber, KEYS } from '~/lib/redis'
import * as engine from '~/lib/game-engine'
import * as state from '~/lib/game-state'
import { TIMING } from '~/lib/timing'
import type {
  ClientToServerEvent,
  ServerToClientEvent,
  SessionState,
  GamePhase,
  Hand,
  Submission,
  PlayerScore,
  GameConfig,
} from '~/lib/types'

type PeerCtx = { code: string; playerId?: string; anonId?: string; lastPing: number }

async function buildSnapshot(code: string, playerId: string): Promise<SessionState | null> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (
    !session ||
    session.status === 'lobby' ||
    session.status === 'ended' ||
    session.status === 'abandoned'
  )
    return null

  const [roundRow] = await db
    .select()
    .from(gameRounds)
    .where(eq(gameRounds.sessionId, session.id))
    .orderBy(desc(gameRounds.roundNum))
    .limit(1)
  if (!roundRow) return null

  const [black] = await db.select().from(blackCards).where(eq(blackCards.id, roundRow.blackCardId))
  if (!black) return null

  const players = await state.getAllPlayers(code)
  const czarId = roundRow.czarPlayerId ?? null
  const config = session.config as GameConfig

  const scores: PlayerScore[] = players.map((p) => ({
    playerId: p.id,
    username: p.username,
    score: p.score,
    isJudge: p.id === czarId,
    isRando: p.isRando,
  }))

  // The public submissionId is the index into the server-persisted
  // permuted order so a reconnecting client agrees with everyone else.
  const rawSubs = await state.getSubmissions(code)
  const subOrder: string[] = JSON.parse((await redis.get(`${KEYS.round(code)}:order`)) ?? '[]')
  const submissions: Submission[] =
    subOrder.length > 0
      ? subOrder.map((k, i) => ({ submissionId: String(i), fills: rawSubs[k]?.fills ?? [] }))
      : Object.values(rawSubs).map((s, i) => ({ submissionId: String(i), fills: s.fills }))
  const revealIndex = Number((await redis.get(`${KEYS.round(code)}:revealed`)) ?? 0)

  const handIds = await state.getHand(code, playerId)
  let hand: Hand | undefined
  if (handIds.length > 0) {
    const cards = await db.select().from(whiteCards).where(inArray(whiteCards.id, handIds))
    hand = handIds.map((id) => {
      const c = cards.find((x) => x.id === id)
      return c ? { id: c.id, text: c.text } : { id, text: '' }
    })
  }

  const activePlayers = players.filter((p) => p.status === 'active')
  const expectedSubmitters = activePlayers.filter((p) => p.id !== czarId && !p.isRando)
  const skippedPlayers = await state.getSkippedPlayers(code)

  let phase: GamePhase = 'picking'
  if (
    submissions.length > 0 &&
    submissions.length + skippedPlayers.length >= expectedSubmitters.length
  ) {
    if (config.rules.includes('godmode')) phase = 'waiting'
    else if (config.rules.includes('survival')) phase = 'eliminating'
    else if (config.rules.includes('serious_business')) phase = 'ranking'
    else phase = 'judging'
  }

  let voteTally: Record<string, number> | undefined
  if (config.rules.includes('godmode')) {
    const tallyRaw = await redis.hgetall(`${KEYS.round(code)}:votetally`)
    if (Object.keys(tallyRaw).length > 0) {
      voteTally = {}
      for (const [sid, n] of Object.entries(tallyRaw)) voteTally[sid] = Number(n)
    }
  }

  return {
    phase,
    round: roundRow.roundNum,
    prompt: { id: black.id, text: black.text, pick: black.pick as 1 | 2 | 3 },
    czarId,
    hand,
    submissions,
    scores,
    revealIndex,
    winnerId: null,
    ...(voteTally ? { voteTally } : {}),
  }
}
const peerContext = new WeakMap<Peer, PeerCtx>()
const roomPeers = new Map<string, Set<Peer>>()

export function startKeepaliveEnforcer(): void {
  setInterval(() => {
    const now = Date.now()
    for (const peers of roomPeers.values()) {
      for (const peer of peers) {
        const ctx = peerContext.get(peer)
        if (ctx && now - ctx.lastPing > TIMING.KEEPALIVE_TIMEOUT_MS) {
          wsLogger.warn({ code: ctx.code, playerId: ctx.playerId }, 'keepalive timeout, closing')
          peer.close(1001, 'keepalive timeout')
        }
      }
    }
  }, TIMING.KEEPALIVE_INTERVAL_MS)
}

function extractCode(url: string): string | null {
  const match = /\/api\/games\/([A-Z0-9]{6})\/ws/.exec(url)
  return match?.[1] ?? null
}

function send(peer: Peer, event: ServerToClientEvent): void {
  try {
    peer.send(JSON.stringify(event))
  } catch (err) {
    wsLogger.warn({ err }, 'send failed')
  }
}

function broadcast(code: string, event: ServerToClientEvent): void {
  const peers = roomPeers.get(code)
  if (!peers) return
  for (const peer of peers) send(peer, event)
}

async function ensureSubscriber(code: string): Promise<void> {
  const channel = KEYS.channel(code)
  const sub = getSubscriber(channel)
  // Only attach listener once (first call per channel)
  if (sub.listenerCount('message') > 0) return
  await sub.subscribe(channel)
  sub.on('message', (_ch, msg) => {
    try {
      const event = JSON.parse(msg) as ServerToClientEvent
      // hand_update is private — route only to its owner, never broadcast.
      if (event.type === 'hand_update') {
        const peers = roomPeers.get(code)
        if (peers) {
          for (const peer of peers) {
            if (peerContext.get(peer)?.playerId === event.playerId) send(peer, event)
          }
        }
        return
      }
      broadcast(code, event)
    } catch (err) {
      wsLogger.error({ err }, 'bad pub/sub payload')
    }
  })
}

export const wsHooks = {
  async open(peer: Peer) {
    const code = extractCode(peer.request.url)
    if (!code) {
      peer.close(1008, 'invalid room')
      return
    }
    peerContext.set(peer, { code, lastPing: Date.now() })
    if (!roomPeers.has(code)) roomPeers.set(code, new Set())
    roomPeers.get(code)!.add(peer)
    await ensureSubscriber(code)
    wsLogger.info({ code }, 'peer opened')
  },

  async message(peer: Peer, msg: Message) {
    const ctx = peerContext.get(peer)
    if (!ctx) return

    let parsed: ClientToServerEvent
    try {
      parsed = JSON.parse(msg.text())
    } catch {
      return send(peer, { type: 'error', code: 'internal_error', message: 'bad JSON' })
    }

    // Auth handshake — must be the first message
    if (!ctx.playerId) {
      if (parsed.type !== 'auth')
        return send(peer, { type: 'error', code: 'not_authorized', message: 'auth first' })
      const auth = await authenticateSocket(ctx.code, parsed)
      if (!auth)
        return send(peer, {
          type: 'auth_error',
          code: 'invalid_token',
          message: 'invalid token',
        })
      ctx.playerId = auth.playerId
      ctx.anonId = auth.anonId
      send(peer, { type: 'auth_ok' })
      const player = await state.getPlayer(ctx.code, auth.playerId)
      if (player?.status === 'grace') {
        await state.updatePlayer(ctx.code, auth.playerId, { status: 'active' })
        await state.clearGrace(ctx.code, auth.playerId)
      }
      return
    }

    ctx.lastPing = Date.now()

    switch (parsed.type) {
      case 'ping':
        return send(peer, { type: 'pong' })
      case 'rejoin': {
        const snapshot = await buildSnapshot(ctx.code, ctx.playerId)
        if (snapshot) send(peer, { type: 'state_snapshot', state: snapshot })
        return
      }
      case 'play':
        await engine.submitCards(ctx.code, ctx.playerId, parsed.cardIds)
        return
      case 'gamble':
        await engine.gamble(ctx.code, ctx.playerId)
        return
      case 'pick':
        await engine.pickWinner(ctx.code, ctx.playerId, parsed.submissionId)
        return
      case 'vote':
        await engine.castVote(ctx.code, ctx.playerId, parsed.submissionId)
        return
      case 'eliminate':
        await engine.eliminateSubmission(ctx.code, ctx.playerId, parsed.submissionId)
        return
      case 'rank':
        await engine.applyRanking(ctx.code, ctx.playerId, parsed.ranking)
        return
      case 'redraw':
        await engine.redraw(ctx.code, ctx.playerId)
        return
      case 'confess_discard':
        await engine.confessDiscard(ctx.code, ctx.playerId, parsed.cardId)
        return
      case 'leave':
        await state.updatePlayer(ctx.code, ctx.playerId, { status: 'dropped' })
        await state.publishEvent(ctx.code, { type: 'player_left', playerId: ctx.playerId })
        captureServerEvent(ctx.playerId, 'cab_player_dropped', {
          roomCode: ctx.code,
          playerId: ctx.playerId,
          reason: 'leave',
        })
        return
    }
  },

  async close(peer: Peer) {
    const ctx = peerContext.get(peer)
    if (!ctx) return
    roomPeers.get(ctx.code)?.delete(peer)
    peerContext.delete(peer)

    if (!ctx.playerId) return
    const playerId = ctx.playerId
    const code = ctx.code

    await state.updatePlayer(code, playerId, { status: 'grace' })
    await state.setGrace(code, playerId, TIMING.GRACE_WINDOW_MS)

    setTimeout(async () => {
      const player = await state.getPlayer(code, playerId)
      if (player?.status === 'grace') {
        await state.updatePlayer(code, playerId, { status: 'dropped' })
        await state.publishEvent(code, { type: 'player_left', playerId })
        captureServerEvent(playerId, 'cab_player_dropped', {
          roomCode: code,
          playerId,
          reason: 'grace',
        })
      }
    }, TIMING.GRACE_WINDOW_MS + 100)

    wsLogger.info({ code, playerId }, 'peer closed')
  },
}
