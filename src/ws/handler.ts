import type { Peer, Message } from 'crossws'
import { randomUUID } from 'node:crypto'
import { eq, inArray, desc } from 'drizzle-orm'
import { db } from '~/db'
import { blackCards, whiteCards, gameSessions, gameRounds } from '~/db/schema'
import { wsLogger } from '~/lib/logger'
import {
  captureServerException,
  distinctIdFor,
  sanitizeServerException,
} from '~/lib/posthog-server'
import { authenticateSocket } from './auth'
import { ClientMessageSchema } from './client-message'
import { redis, getSubscriber, KEYS } from '~/lib/redis'
import * as engine from '~/lib/game-engine'
import { GameCommandError } from '~/lib/game-command-error'
import { getRoomParticipation } from '~/lib/room-session'
import * as state from '~/lib/game-state'
import { TIMING } from '~/lib/timing'
import type {
  ClientToServerEvent,
  ServerToClientEvent,
  SessionState,
  SessionStatus,
  GamePhase,
  GamePlayer,
  Hand,
  Submission,
  PlayerScore,
  GameConfig,
} from '~/lib/types'

// S2-3: a spectator socket may keep the connection alive and re-sync,
// but never drive the game.
const GAME_ACTIONS = new Set<ClientToServerEvent['type']>([
  'play',
  'gamble',
  'pick',
  'rank',
  'vote',
  'eliminate',
  'redraw',
  'confess_discard',
  'happy_ending',
])

type PeerCtx = {
  code: string
  playerId?: string
  anonId?: string
  lastPing: number
  leaving?: boolean
  authenticating?: boolean
  authSetup?: Promise<boolean>
}

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
  const me = players.find((p) => p.id === playerId)

  const scores: PlayerScore[] = engine.toPlayerScores(players, czarId)

  // No public IDs exist until the engine persists its shuffled order.
  // Picking reconnects use progress and the recipient's private receipt
  // instead of exposing submission arrival order.
  const rawSubs = await state.getSubmissions(code)
  const subOrder: string[] = JSON.parse((await redis.get(`${KEYS.round(code)}:order`)) ?? '[]')
  const persistedRevealIndex = Number((await redis.get(`${KEYS.round(code)}:revealed`)) ?? 0)

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

  // S2-9: the engine persists the authoritative phase at every
  // transition (state.setPhase). Trust it so a reconnect during
  // reveal/judging/transition resumes correctly; the submission-count
  // heuristic is only a defensive fallback for a room with no phase yet.
  const persistedPhase = await state.getPhase(code)
  let phase: GamePhase | null = persistedPhase
  if (!phase) {
    phase = 'picking'
    if (
      Object.keys(rawSubs).length > 0 &&
      Object.keys(rawSubs).length + skippedPlayers.length >= expectedSubmitters.length
    ) {
      if (config.rules.includes('godmode')) phase = 'waiting'
      else if (config.rules.includes('survival')) phase = 'eliminating'
      else if (config.rules.includes('serious_business')) phase = 'ranking'
      else phase = 'judging'
    }
  }

  // Completed phases also cover boot recovery's reveal fast-forward,
  // which advances the phase without replaying individual reveal frames.
  const completedReveal =
    persistedPhase === 'judging' ||
    persistedPhase === 'eliminating' ||
    persistedPhase === 'ranking' ||
    persistedPhase === 'transition' ||
    (persistedPhase === 'waiting' && config.rules.includes('godmode'))
  const revealIndex = completedReveal
    ? subOrder.length
    : Math.max(0, Math.min(subOrder.length, persistedRevealIndex))

  // All recipients, including the submitter and Czar, see only answers
  // whose scheduled reveal has happened. Empty fills retain stable slots
  // without transmitting a hidden card ID, text, or submitter identity.
  let submissions: Submission[] =
    phase === 'picking'
      ? []
      : subOrder.map((key, index) => ({
          submissionId: String(index),
          fills: index < revealIndex ? (rawSubs[key]?.fills ?? []) : [],
          // Elimination is public once announced; keep it across rejoin
          // without exposing the stored submission's player attribution.
          eliminated: rawSubs[key]?.eliminated,
        }))

  let voteTally: Record<string, number> | undefined
  if (config.rules.includes('godmode')) {
    const tallyRaw = await redis.hgetall(`${KEYS.round(code)}:votetally`)
    if (Object.keys(tallyRaw).length > 0) {
      voteTally = {}
      for (const [sid, n] of Object.entries(tallyRaw)) voteTally[sid] = Number(n)
    }
  }

  // S2-9: the round outcome is persisted at resolution so a reconnect
  // during the post-resolve 'transition' window (and the Survival
  // elimination turn / Serious Business ranking) is restored instead of
  // being lost. clearRoundResolution wipes these at the next startRound.
  const { submitted, expected } = await engine.submissionProgress(code)
  const roundTimerExpiresAt = await state.getRoundTimerExpiresAt(code)
  const outcome = await state.getRoundOutcome(code)
  if (phase === 'transition' && submissions.length === 0) {
    submissions = JSON.parse((await redis.hget(KEYS.round(code), 'resolvedSubmissions')) ?? '[]')
  }
  const eliminationTurnPlayerId = config.rules.includes('survival')
    ? ((await state.getEliminationTurn(code)) ?? undefined)
    : undefined
  const ranking = config.rules.includes('serious_business')
    ? ((await state.getRoundRanking(code)) ?? undefined)
    : undefined

  return {
    phase,
    round: roundRow.roundNum,
    prompt: { id: black.id, text: black.text, pick: black.pick as 1 | 2 | 3 },
    czarId,
    hostId: session.hostPlayerId,
    config,
    hand,
    submissions,
    scores,
    revealIndex: phase === 'transition' ? submissions.length : revealIndex,
    winnerId: outcome.winningPlayerId,
    ...outcome,
    submitted,
    expected,
    roundTimerExpiresAt,
    myDiscardsUsed: me?.discardsUsed ?? 0,
    myHasGambled: me?.hasGambled ?? false,
    mySubmissionCount: Number(!!rawSubs[playerId]) + Number(!!rawSubs[`${playerId}:gamble`]),
    myVotedSubmissionId: await redis.hget(`${KEYS.round(code)}:voterchoices`, playerId),
    ...(voteTally ? { voteTally } : {}),
    ...(eliminationTurnPlayerId ? { eliminationTurnPlayerId } : {}),
    ...(ranking ? { ranking } : {}),
  }
}

// S2-5: buildSnapshot only covers in-progress games (it needs a round
// row). The lobby is pre-game, so a reconnecting/refreshing client needs
// the roster + config + session status to render and to know whether the
// game has since started or ended.
async function buildLobbySnapshot(code: string): Promise<{
  players: GamePlayer[]
  config: GameConfig
  gameStatus: SessionStatus
} | null> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) return null
  return {
    players: await state.getAllPlayers(code),
    config: session.config as GameConfig,
    gameStatus: session.status as SessionStatus,
  }
}

const peerContext = new WeakMap<Peer, PeerCtx>()
// Pending sockets need keepalive enforcement but must never receive room events.
const openPeers = new Set<Peer>()
const roomPeers = new Map<string, Set<Peer>>()

export function startKeepaliveEnforcer(): void {
  setInterval(() => {
    const now = Date.now()
    for (const peer of openPeers) {
      const ctx = peerContext.get(peer)
      if (ctx && now - ctx.lastPing > TIMING.KEEPALIVE_TIMEOUT_MS) {
        wsLogger.warn({ code: ctx.code, playerId: ctx.playerId }, 'keepalive timeout, closing')
        peer.close(1001, 'keepalive timeout')
      }
    }
  }, TIMING.KEEPALIVE_INTERVAL_MS)
}

function extractCode(url: string): string | null {
  // S3-1: accept a lowercased code in the WS URL; codes are stored
  // raw-uppercase, so normalize before any lookup keys off it.
  const match = /\/api\/games\/([A-Za-z0-9]{6})\/ws/.exec(url)
  return match?.[1]?.toUpperCase() ?? null
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
  for (const peer of peers) {
    if (!peerContext.get(peer)?.authenticating) send(peer, event)
  }
}

function revokePlayerSockets(
  code: string,
  playerId: string,
  errorCode: 'player_dropped' | 'invalid_token' = 'player_dropped',
): void {
  for (const peer of roomPeers.get(code) ?? []) {
    if (peerContext.get(peer)?.playerId !== playerId) continue
    roomPeers.get(code)?.delete(peer)
    openPeers.delete(peer)
    peerContext.delete(peer)
    const message = errorCode === 'player_dropped' ? 'player dropped' : 'invalid token'
    send(peer, { type: 'auth_error', code: errorCode, message })
    peer.close(1008, message)
  }
}

async function ensureSubscriber(code: string): Promise<void> {
  const channel = KEYS.channel(code)
  const sub = getSubscriber(channel)
  // Only attach the listener once per channel. Attach it BEFORE awaiting
  // subscribe: peers connect concurrently and all call this, so the
  // guard check and the `sub.on` that satisfies it must run with no
  // `await` between them — otherwise every racing peer slips past a
  // still-zero listenerCount while `subscribe` is in flight and adds its
  // own listener, fanning each published event out 2–3× (a single
  // round_started/reveal then duplicates per extra listener).
  if (sub.listenerCount('message') > 0) {
    // Listener exists but a concurrent first caller may still be
    // awaiting subscribe; ensure this channel is subscribed before
    // returning so we don't miss frames.
    await sub.subscribe(channel)
    return
  }
  sub.on('message', (_ch, msg) => {
    try {
      const event = JSON.parse(msg) as ServerToClientEvent
      // Every drop path publishes this event, including HTTP leave and
      // grace expiry. Revoke all connections before any more room fanout.
      if (event.type === 'player_left') revokePlayerSockets(code, event.playerId)
      // hand_update is private — route only to its owner, never broadcast.
      if (event.type === 'hand_update') {
        const peers = roomPeers.get(code)
        if (peers) {
          for (const peer of peers) {
            const ctx = peerContext.get(peer)
            if (ctx?.playerId === event.playerId && !ctx.authenticating) send(peer, event)
          }
        }
        return
      }
      broadcast(code, event)
    } catch (err) {
      wsLogger.error({ err }, 'bad pub/sub payload')
    }
  })
  await sub.subscribe(channel)
}

export const wsHooks = {
  async open(peer: Peer) {
    const code = extractCode(peer.request.url)
    if (!code) {
      peer.close(1008, 'invalid room')
      return
    }
    peerContext.set(peer, { code, lastPing: Date.now() })
    openPeers.add(peer)
    wsLogger.info({ code }, 'peer opened')
  },

  async message(peer: Peer, msg: Message) {
    const ctx = peerContext.get(peer)
    if (!ctx) return

    let eventType: ClientToServerEvent['type'] | undefined
    let commandId: string | undefined
    let accepted = false
    const accept = (ok: boolean) => {
      accepted = ok
      if (!commandId) return
      send(
        peer,
        ok
          ? { type: 'command_accepted', commandId }
          : {
              type: 'error',
              code: 'invalid_state',
              message: 'Action was not accepted. Try again.',
              commandId,
            },
      )
    }
    try {
      if (ctx.authenticating)
        return send(peer, { type: 'error', code: 'not_authorized', message: 'auth first' })
      let input: unknown
      try {
        input = JSON.parse(msg.text())
      } catch {
        return send(peer, { type: 'error', code: 'invalid_state', message: 'Invalid command' })
      }

      const result = ClientMessageSchema.safeParse(input)
      if (!result.success) {
        const id =
          typeof input === 'object' && input !== null && 'commandId' in input
            ? input.commandId
            : undefined
        return send(peer, {
          type: 'error',
          code: 'invalid_state',
          message: 'Invalid command',
          ...(typeof id === 'string' && id.length > 0 && id.length <= 256 ? { commandId: id } : {}),
        })
      }
      const parsed = result.data
      commandId = 'commandId' in parsed ? parsed.commandId : undefined
      eventType = parsed.type

      // Auth handshake — must be the first message
      if (!ctx.playerId) {
        if (parsed.type !== 'auth')
          return send(peer, {
            type: 'error',
            code: 'not_authorized',
            message: 'auth first',
            ...(commandId ? { commandId } : {}),
          })
        ctx.authenticating = true
        const auth = await authenticateSocket(ctx.code, parsed)
        if (peerContext.get(peer) !== ctx) return
        if (!auth.ok) {
          send(peer, {
            type: 'auth_error',
            code: auth.code,
            message: auth.code === 'player_dropped' ? 'player dropped' : 'invalid token',
          })
          roomPeers.get(ctx.code)?.delete(peer)
          openPeers.delete(peer)
          peerContext.delete(peer)
          peer.close(1008, 'authentication failed')
          return
        }
        await ensureSubscriber(ctx.code)
        // Authentication can finish after a pending socket disconnected.
        if (peerContext.get(peer) !== ctx) return
        const participation = await getRoomParticipation(ctx.code, auth.playerId)
        if (peerContext.get(peer) !== ctx) return
        if (!participation.ok) {
          send(peer, {
            type: 'auth_error',
            code: participation.code,
            message: participation.code === 'player_dropped' ? 'player dropped' : 'invalid token',
          })
          openPeers.delete(peer)
          peerContext.delete(peer)
          peer.close(1008, 'authentication failed')
          return
        }
        ctx.playerId = auth.playerId
        ctx.anonId = auth.anonId
        // Track the binding before the atomic restore so a concurrent drop
        // revokes setup too. Pending setup receives no room broadcasts.
        if (!roomPeers.has(ctx.code)) roomPeers.set(ctx.code, new Set())
        roomPeers.get(ctx.code)!.add(peer)
        ctx.authSetup = state.reconnectPlayer(ctx.code, auth.playerId)
        const restored = await ctx.authSetup
        if (peerContext.get(peer) !== ctx) return
        if (!restored) {
          const current = await getRoomParticipation(ctx.code, auth.playerId)
          revokePlayerSockets(ctx.code, auth.playerId, current.ok ? 'invalid_token' : current.code)
          return
        }
        ctx.lastPing = Date.now()
        ctx.authenticating = false
        send(peer, { type: 'auth_ok' })
        return
      }

      ctx.lastPing = Date.now()

      // A socket authenticates identity, not permanent participation.
      // HTTP leave, activation and another connection can change it.
      if (ctx.leaving) return
      const participation = await getRoomParticipation(ctx.code, ctx.playerId)
      if (peerContext.get(peer) !== ctx) return
      if (ctx.leaving) return
      if (!participation.ok) {
        revokePlayerSockets(ctx.code, ctx.playerId, participation.code)
        return
      }
      const currentPlayer = participation.player
      if (GAME_ACTIONS.has(parsed.type)) {
        if (currentPlayer.role === 'spectator') {
          return send(peer, {
            type: 'error',
            code: 'spectator_action',
            message: 'spectators cannot perform game actions',
            ...(commandId ? { commandId } : {}),
          })
        }
        if (currentPlayer.status !== 'active' || currentPlayer.isRando) {
          return send(peer, {
            type: 'error',
            code: 'not_authorized',
            message: 'Only active players can perform game actions',
            ...(commandId ? { commandId } : {}),
          })
        }
      }

      switch (parsed.type) {
        case 'ping':
          return send(peer, { type: 'pong' })
        case 'rejoin': {
          const snapshot = await buildSnapshot(ctx.code, ctx.playerId)
          if (snapshot) {
            send(peer, { type: 'state_snapshot', state: snapshot })
            return
          }
          const lobby = await buildLobbySnapshot(ctx.code)
          if (lobby) send(peer, { type: 'lobby_snapshot', ...lobby })
          return
        }
        case 'play':
          await engine.submitCards(ctx.code, ctx.playerId, parsed.cardIds, accept)
          return
        case 'gamble':
          await engine.gamble(ctx.code, ctx.playerId)
          return
        case 'pick':
          await engine.pickWinner(ctx.code, ctx.playerId, parsed.submissionId, accept)
          return
        case 'vote':
          await engine.castVote(ctx.code, ctx.playerId, parsed.submissionId, accept)
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
        case 'happy_ending':
          await engine.triggerHappyEnding(ctx.code, ctx.playerId)
          return
        case 'leave':
          // The drop event revokes every socket bound to this identity.
          ctx.leaving = true
          await engine.dropPlayer(ctx.code, ctx.playerId, 'leave')
          revokePlayerSockets(ctx.code, ctx.playerId)
          return
      }
    } catch (err) {
      if (eventType === 'leave') ctx.leaving = false
      if (err instanceof GameCommandError) {
        if (!accepted)
          send(peer, {
            type: 'error',
            code: err.code,
            message: err.message,
            ...(commandId ? { commandId } : {}),
          })
        return
      }
      // Exceptions can contain card IDs, hands, tokens or database values.
      // Preserve verified source locations, never the frame or raw exception.
      const safeError = sanitizeServerException(err)
      wsLogger.error(
        { err: safeError, roomCode: ctx.code, playerId: ctx.playerId, eventType },
        'WebSocket command failed',
      )
      if (!accepted)
        send(peer, {
          type: 'error',
          code: 'internal_error',
          message: 'Command failed',
          ...(commandId ? { commandId } : {}),
        })
      if (ctx.authenticating) {
        // Setup may have bound the identity before a grace write failed.
        // Keep commands blocked until close restores grace for that identity.
        roomPeers.get(ctx.code)?.delete(peer)
        openPeers.delete(peer)
        peer.close(1011, 'authentication setup failed')
      }
      captureServerException(
        ctx.playerId ? await distinctIdFor(ctx.code, ctx.playerId) : ctx.code,
        safeError,
        {
          roomCode: ctx.code,
          eventType,
        },
      )
    }
  },

  async close(peer: Peer) {
    openPeers.delete(peer)
    const ctx = peerContext.get(peer)
    if (!ctx) return
    roomPeers.get(ctx.code)?.delete(peer)
    peerContext.delete(peer)

    if (!ctx.playerId) return
    // The command handler reports setup failures. They must not prevent
    // close from restoring grace and releasing the connection.
    await ctx.authSetup?.catch(() => {})
    const playerId = ctx.playerId
    const code = ctx.code

    // S2-5: an explicit `leave` already dropped this player. Don't
    // resurrect them into 'grace' or schedule a duplicate drop.
    const hasOtherSocket = () =>
      [...(roomPeers.get(code) ?? [])].some(
        (other) => peerContext.get(other)?.playerId === playerId,
      )
    if (hasOtherSocket()) return
    const deadline = randomUUID()
    if (!(await state.disconnectPlayer(code, playerId, deadline, TIMING.GRACE_WINDOW_MS))) return
    // An authentication may finish while the disconnect write is in flight.
    if (hasOtherSocket()) {
      await state.reconnectPlayer(code, playerId)
      return
    }

    // Grace window: drop only if the player never reconnected (auth
    // flips 'grace' → 'active'). dropPlayer runs the void/migrate/pause
    // path and is idempotent.
    setTimeout(() => {
      if (!hasOtherSocket()) {
        void engine.dropPlayer(code, playerId, 'grace', deadline).catch((err) => {
          if (err instanceof GameCommandError && err.code === 'invalid_token') return
          wsLogger.error({ err: sanitizeServerException(err), code, playerId }, 'grace drop failed')
        })
      }
    }, TIMING.GRACE_WINDOW_MS + 100)

    wsLogger.info({ code, playerId }, 'peer closed')
  },
}
