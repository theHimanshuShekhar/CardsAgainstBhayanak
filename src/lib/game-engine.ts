import { db } from '~/db'
import { blackCards, whiteCards, gameSessions, gamePlayers, gameRounds } from '~/db/schema'
import { inArray, eq, sql, desc } from 'drizzle-orm'
import { randomInt, shuffle } from './rng'
import { redis, KEYS, ROOM_TTL_SECONDS } from './redis'
import * as state from './game-state'
import { engineLogger } from './logger'
import { captureServerEvent } from './posthog-server'
import { TIMER_MS, REVEAL_STAGGER } from './timing'
import type { GameConfig, GameOverMode, Submission, Card, BlackCard } from './types'
import { createId } from '@paralleldrive/cuid2'

export function chooseFirstCzar(activePlayerCount: number): number {
  return randomInt(0, activePlayerCount)
}

export async function buildDecks(code: string, packIds: string[]): Promise<void> {
  const black = await db.select().from(blackCards).where(inArray(blackCards.packId, packIds))
  const white = await db.select().from(whiteCards).where(inArray(whiteCards.packId, packIds))
  const blackIds = shuffle(black.map((b) => b.id))
  const whiteIds = shuffle(white.map((w) => w.id))
  await state.pushDeck(code, 'black', blackIds)
  await state.pushDeck(code, 'white', whiteIds)
  engineLogger.info({ code, black: blackIds.length, white: whiteIds.length }, 'decks built')
}

export async function dealStartingHands(
  code: string,
  playerIds: string[],
): Promise<Record<string, string[]>> {
  const hands: Record<string, string[]> = {}
  for (const pid of playerIds) {
    const cards = await state.drawCards(code, 'white', 10)
    await state.setHand(code, pid, cards)
    hands[pid] = cards
  }
  return hands
}

export async function startGame(code: string): Promise<void> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) throw new Error('session not found')
  const config = session.config as GameConfig

  await buildDecks(code, config.packs)

  const activePlayers = await db
    .select()
    .from(gamePlayers)
    .where(
      sql`${gamePlayers.sessionId} = ${session.id} AND ${gamePlayers.role} = 'player' AND ${gamePlayers.status} = 'active'`,
    )

  if (config.rules.includes('rando')) {
    const [rando] = await db
      .insert(gamePlayers)
      .values({
        sessionId: session.id,
        username: 'Rando Cardrissian',
        role: 'player',
        status: 'active',
        isRando: true,
      })
      .returning()
    if (rando) activePlayers.push(rando)
  }

  const playerIds = activePlayers.map((p) => p.id)
  await state.setCzarOrder(code, playerIds)
  await dealStartingHands(code, playerIds)

  const firstCzarIdx = chooseFirstCzar(activePlayers.length)
  await db.update(gameSessions).set({ status: 'active' }).where(eq(gameSessions.id, session.id))

  engineLogger.info({ code, firstCzarIdx, players: activePlayers.length }, 'game started')
}

// forceCzarId: undefined = normal rotation, string/null = override (used when voiding a round)
export async function startRound(
  code: string,
  round: number,
  forceCzarId?: string | null,
): Promise<{ prompt: BlackCard; czarId: string | null }> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) throw new Error('session not found')
  const config = session.config as GameConfig

  const blackIds = await state.drawCards(code, 'black', 1)
  if (blackIds.length === 0) {
    await endGame(code, 'deck_exhausted')
    throw new Error('deck_exhausted')
  }
  const [black] = await db
    .select()
    .from(blackCards)
    .where(eq(blackCards.id, blackIds[0] ?? ''))
  if (!black) throw new Error('black card missing')

  let czarId: string | null = null
  if (forceCzarId !== undefined) {
    czarId = forceCzarId
  } else if (!config.rules.includes('godmode')) {
    const order = await state.getCzarOrder(code)
    const allPlayers = await state.getAllPlayers(code)
    const activeOrder = order.filter((pid) => {
      const p = allPlayers.find((x) => x.id === pid)
      return p && p.status === 'active' && !p.isRando
    })
    czarId = activeOrder[(round - 1) % activeOrder.length] ?? null
  }

  await state.clearSkippedPlayers(code)
  await state.setCurrentRound(code, round)

  await db
    .insert(gameRounds)
    .values({
      sessionId: session.id,
      roundNum: round,
      blackCardId: black.id,
      czarPlayerId: czarId ?? undefined,
    })
    .onConflictDoNothing()

  await state.publishEvent(code, {
    type: 'round_started',
    round,
    prompt: { id: black.id, text: black.text, pick: black.pick },
    czarId,
  })
  captureServerEvent(code, 'cab_round_started', {
    roomCode: code,
    round,
    czarId,
    blackCardPick: black.pick,
  })

  if (config.timer !== 'Off') {
    const ms = TIMER_MS[config.timer]
    const expiresAt = Date.now() + ms
    await state.setRoundTimerExpiresAt(code, expiresAt)
    setTimeout(() => void expireRoundTimer(code, round, czarId), ms)
  }

  engineLogger.info({ code, round, czarId, blackCardId: black.id }, 'round started')
  return { prompt: { id: black.id, text: black.text, pick: black.pick } as BlackCard, czarId }
}

export async function expireRoundTimer(
  code: string,
  round: number,
  czarId: string | null,
): Promise<void> {
  // Guard: if the round has already advanced, this is a stale timer
  const currentRound = await state.getCurrentRound(code)
  if (currentRound !== round) return

  const [submissions, players] = await Promise.all([
    state.getSubmissions(code),
    state.getAllPlayers(code),
  ])

  const activePlayers = players.filter((p) => p.status === 'active' && !p.isRando)
  const expectedSubmitters = activePlayers.filter((p) => p.id !== czarId)
  const submittedIds = new Set(Object.keys(submissions).map(resolvePlayerId))

  for (const player of expectedSubmitters) {
    if (!submittedIds.has(player.id)) {
      await state.addSkippedPlayer(code, player.id)
      await state.publishEvent(code, { type: 'player_skipped', playerId: player.id, round })
      captureServerEvent(player.id, 'cab_player_skipped', {
        roomCode: code,
        playerId: player.id,
        round,
      })
    }
  }

  const uniqueSubmitters = new Set(Object.keys(submissions).map(resolvePlayerId))
  if (uniqueSubmitters.size < 2) {
    engineLogger.info(
      { code, round, submitters: uniqueSubmitters.size },
      'round voided — too few submissions',
    )
    await state.clearSubmissions(code)
    await state.clearSkippedPlayers(code)
    await startRound(code, round + 1, czarId)
    return
  }
  // 2+ submissions: skipped players are excluded, so the round is now ready.
  await checkRoundReady(code)
}

// ── Reveal / judging orchestration ────────────────────────────────
//
// The public submissionId is the index into a server-persisted permuted
// order. The submissionId → playerId mapping stays hidden until reveal
// (spec § Submission ordering).
const subOrderKey = (code: string) => `${KEYS.round(code)}:order`
const resolvingKey = (code: string) => `${KEYS.round(code)}:resolving`
const revealedKey = (code: string) => `${KEYS.round(code)}:revealed`

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function getSubOrder(code: string): Promise<string[]> {
  const raw = await redis.get(subOrderKey(code))
  return raw ? (JSON.parse(raw) as string[]) : []
}

// publicId is the index string the client sends back (pick/vote/eliminate/rank).
async function resolveSubmissionKey(code: string, publicId: string): Promise<string | null> {
  const order = await getSubOrder(code)
  const idx = Number(publicId)
  if (!Number.isInteger(idx) || idx < 0 || idx >= order.length) return null
  return order[idx] ?? null
}

export function publicIdForKey(order: string[], key: string): string {
  return String(order.indexOf(key))
}

// Detects "all expected players have submitted", then drives the
// server-controlled reveal and hands off to the mode-specific resolver.
export async function checkRoundReady(code: string): Promise<void> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) return
  const config = session.config as GameConfig

  const [roundRow] = await db
    .select()
    .from(gameRounds)
    .where(eq(gameRounds.sessionId, session.id))
    .orderBy(desc(gameRounds.roundNum))
    .limit(1)
  if (!roundRow) return
  const czarId = roundRow.czarPlayerId ?? null

  const [submissions, players, skipped] = await Promise.all([
    state.getSubmissions(code),
    state.getAllPlayers(code),
    state.getSkippedPlayers(code),
  ])

  const skippedSet = new Set(skipped)
  const expected = players.filter(
    (p) => p.status === 'active' && p.id !== czarId && !p.isRando && !skippedSet.has(p.id),
  )
  const submitted = new Set(Object.keys(submissions).map(resolvePlayerId))
  const ready =
    expected.length > 0 && expected.every((p) => submitted.has(p.id)) && submitted.size >= 2
  if (!ready) return

  // Resolve exactly once per round (guards concurrent last submissions).
  const first = await redis.setnx(resolvingKey(code), '1')
  if (first === 0) return
  await redis.expire(resolvingKey(code), ROOM_TTL_SECONDS)

  // Permute storage keys once; persist so pick/vote/eliminate and the
  // rejoin snapshot all agree on index → submission.
  const order = shuffle(Object.keys(submissions))
  await redis.set(subOrderKey(code), JSON.stringify(order), 'EX', ROOM_TTL_SECONDS)

  await state.publishEvent(code, { type: 'reveal_start' })
  for (let i = 0; i < order.length; i++) {
    const sub = submissions[order[i]!]
    if (!sub) continue
    await sleep(REVEAL_STAGGER)
    await redis.set(revealedKey(code), String(i + 1), 'EX', ROOM_TTL_SECONDS)
    await state.publishEvent(code, { type: 'card_revealed', submissionIndex: i, fills: sub.fills })
  }

  if (config.rules.includes('survival')) {
    const turnOrder = players.filter((p) => p.status === 'active' && p.id !== czarId && !p.isRando)
    const firstP = turnOrder[0]
    if (firstP) {
      await redis.hset(KEYS.round(code), 'eliminationTurnPlayerId', firstP.id)
      await redis.expire(KEYS.round(code), ROOM_TTL_SECONDS)
      await state.publishEvent(code, { type: 'elimination_turn', playerId: firstP.id })
    }
  } else if (config.rules.includes('godmode')) {
    await state.publishEvent(code, { type: 'vote_tally', votes: {} })
  }
  // serious_business / normal: the Czar now ranks / picks (client-driven).
}

export async function submitCards(
  code: string,
  playerId: string,
  cardIds: string[],
): Promise<void> {
  const allCards = await db.select().from(whiteCards).where(inArray(whiteCards.id, cardIds))
  const fills: Card[] = cardIds.map((id) => {
    const c = allCards.find((x) => x.id === id)
    if (!c) throw new Error(`card ${id} not found`)
    return { id: c.id, text: c.text }
  })
  const submission: Submission = { submissionId: createId(), fills, playerId }

  // Gamblers get a second anonymous slot; regular submission goes under playerId
  const [player, existingSubs] = await Promise.all([
    state.getPlayer(code, playerId),
    state.getSubmissions(code),
  ])
  const storageKey = player?.hasGambled && existingSubs[playerId] ? `${playerId}:gamble` : playerId

  await state.setSubmission(code, storageKey, submission)
  await state.removeFromHand(code, playerId, cardIds)
  await state.publishEvent(code, { type: 'player_played', playerId })
  captureServerEvent(playerId, 'cab_card_played', {
    roomCode: code,
    playerId,
    pickCount: cardIds.length,
  })
  await checkRoundReady(code)
}

export async function pickWinner(
  code: string,
  czarId: string,
  submissionId: string,
): Promise<void> {
  const submissions = await state.getSubmissions(code)
  const winnerKey = await resolveSubmissionKey(code, submissionId)
  if (!winnerKey || !submissions[winnerKey]) throw new Error('submission not found')
  const winnerPlayerId = resolvePlayerId(winnerKey)

  const winner = await state.getPlayer(code, winnerPlayerId)
  if (!winner) throw new Error('winner not found')
  const bonus = countGambleTransfers(submissions, winnerPlayerId)
  const gain = 1 + bonus
  await state.updatePlayer(code, winnerPlayerId, { score: winner.score + gain })

  const players = await state.getAllPlayers(code)
  const scores = players.map((p) => ({
    playerId: p.id,
    username: p.username,
    score: p.id === winnerPlayerId ? p.score + gain : p.score,
    isJudge: p.id === czarId,
    isRando: p.isRando,
  }))

  await state.publishEvent(code, {
    type: 'round_won',
    winnerId: winnerPlayerId,
    submissionId,
    scores,
  })
  captureServerEvent(czarId, 'cab_winner_picked', {
    roomCode: code,
    winnerId: winnerPlayerId,
    isRando: winner.isRando,
  })
  await endRound(code, Object.keys(submissions))
}

export async function endRound(code: string, submitterIds: string[]): Promise<void> {
  const submissions = await state.getSubmissions(code)
  const allFillIds: string[] = []
  for (const s of Object.values(submissions)) for (const f of s.fills) allFillIds.push(f.id)
  await state.discardCards(code, 'white', allFillIds)

  const activePlayers = await state.getAllPlayers(code)
  const activeCount = activePlayers.filter((p) => p.status === 'active').length
  await state.reshuffleWhiteIfLow(code, activeCount * 3)

  // Resolve to unique real playerIds (strip ':gamble' keys)
  const realSubmitterIds = [...new Set(submitterIds.map(resolvePlayerId))]

  // Track raw card ID arrays per player, hydrate to Card objects after all draws
  const rawHands: Record<string, string[]> = {}
  for (const pid of realSubmitterIds) {
    const current = await state.getHand(code, pid)
    const needed = 10 - current.length
    if (needed > 0) {
      const drawn = await state.drawCards(code, 'white', needed)
      const newHand = [...current, ...drawn]
      await state.setHand(code, pid, newHand)
      rawHands[pid] = newHand
    } else {
      rawHands[pid] = current
    }
  }

  await state.clearSubmissions(code)
  await redis.del(subOrderKey(code), resolvingKey(code), revealedKey(code))

  const players = await state.getAllPlayers(code)
  // Clear gamble flag for all players who gambled this round
  for (const p of players) {
    if (p.hasGambled) await state.updatePlayer(code, p.id, { hasGambled: false })
  }
  const activated: string[] = []
  for (const p of players) {
    if (p.status === 'queued') {
      await state.updatePlayer(code, p.id, { status: 'active' })
      activated.push(p.id)
      const dealt = await state.drawCards(code, 'white', 10)
      await state.setHand(code, p.id, dealt)
      rawHands[p.id] = dealt
    }
  }

  // Hydrate all card IDs → Card objects in one batch query
  const allCardIds = [...new Set(Object.values(rawHands).flat())]
  const cardRows =
    allCardIds.length > 0
      ? await db.select().from(whiteCards).where(inArray(whiteCards.id, allCardIds))
      : []
  const cardMap = new Map(cardRows.map((c) => [c.id, { id: c.id, text: c.text }]))
  const handsRefilled: Record<string, Card[]> = {}
  for (const [pid, ids] of Object.entries(rawHands)) {
    handsRefilled[pid] = ids.map((id) => cardMap.get(id) ?? { id, text: '' })
  }

  await state.publishEvent(code, { type: 'round_end', activatedPlayers: activated, handsRefilled })

  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) return
  const config = session.config as GameConfig
  const refreshed = await state.getAllPlayers(code)
  const winnerPlayer = refreshed.find((p) => p.score >= config.roundsToWin)
  if (winnerPlayer) {
    await endGame(code, winnerPlayer.isRando ? 'rando_won' : 'normal', winnerPlayer.id)
    return
  }

  const nextRound = (await state.getCurrentRound(code)) + 1
  await startRound(code, nextRound)
}

export async function endGame(code: string, mode: GameOverMode, winnerId?: string): Promise<void> {
  const players = await state.getAllPlayers(code)
  const finalScores = players.map((p) => ({
    playerId: p.id,
    username: p.username,
    score: p.score,
    isJudge: false,
    isRando: p.isRando,
  }))

  await db
    .update(gameSessions)
    .set({ status: 'ended', endedAt: new Date(), endMode: mode, winnerPlayerId: winnerId ?? null })
    .where(eq(gameSessions.code, code))

  await state.publishEvent(code, { type: 'game_over', finalScores, winnerId: winnerId ?? '', mode })
  engineLogger.info({ code, mode, winnerId }, 'game over')
}

// ── House rule mechanics ──────────────────────────────────────────

// Gamble submissions are stored under `${playerId}:gamble` in the submissions hash.
function resolvePlayerId(key: string): string {
  return key.endsWith(':gamble') ? key.slice(0, -7) : key
}

// Returns extra points the round winner earns from failed gamblers (point transfer mechanic).
function countGambleTransfers(
  submissions: Record<string, import('./types').Submission>,
  winnerPlayerId: string,
): number {
  let bonus = 0
  for (const key of Object.keys(submissions)) {
    if (!key.endsWith(':gamble')) continue
    const gamblerId = resolvePlayerId(key)
    if (gamblerId === winnerPlayerId) continue // their gamble sub won → they keep their point
    // Check if the gambler's regular sub also lost
    if (submissions[gamblerId]) bonus += 1
  }
  return bonus
}

export async function castVote(
  code: string,
  _voterId: string,
  submissionId: string,
): Promise<void> {
  const voteTallyKey = `${KEYS.round(code)}:votetally`
  const tieKey = `${KEYS.round(code)}:tiebreak`

  await redis.hincrby(voteTallyKey, submissionId, 1)
  await redis.expire(voteTallyKey, ROOM_TTL_SECONDS)

  const players = await state.getAllPlayers(code)
  const voters = players.filter((p) => p.status === 'active' && !p.isRando)
  const submissions = await state.getSubmissions(code)

  const tallyRaw = await redis.hgetall(voteTallyKey)
  const tally: Record<string, number> = {}
  for (const [sid, n] of Object.entries(tallyRaw)) tally[sid] = Number(n)
  const totalVotes = Object.values(tally).reduce((a, b) => a + b, 0)

  await state.publishEvent(code, { type: 'vote_tally', votes: tally })

  if (totalVotes < voters.length) return

  const maxVotes = Math.max(...Object.values(tally))
  const leaders = Object.entries(tally)
    .filter(([, n]) => n === maxVotes)
    .map(([sid]) => sid)

  if (leaders.length > 1) {
    // Tied — re-vote up to ×2 before falling back to random (spec: "tie re-vote ×2 then random")
    const attempts = await redis.incr(tieKey)
    await redis.expire(tieKey, ROOM_TTL_SECONDS)
    if (attempts <= 2) {
      await redis.del(voteTallyKey)
      await state.publishEvent(code, { type: 'vote_tally', votes: {} })
      return
    }
    await redis.del(tieKey)
  }

  const winnerSubmissionId =
    leaders.length === 1 ? leaders[0]! : leaders[Math.floor(Math.random() * leaders.length)]!

  const winnerKey = await resolveSubmissionKey(code, winnerSubmissionId)
  if (!winnerKey) return
  const winnerPlayerId = resolvePlayerId(winnerKey)

  const winner = await state.getPlayer(code, winnerPlayerId)
  if (!winner) return
  const bonus = countGambleTransfers(submissions, winnerPlayerId)
  const gain = 1 + bonus
  await state.updatePlayer(code, winnerPlayerId, { score: winner.score + gain })

  const allPlayers = await state.getAllPlayers(code)
  const scores = allPlayers.map((p) => ({
    playerId: p.id,
    username: p.username,
    score: p.id === winnerPlayerId ? p.score + gain : p.score,
    isJudge: false,
    isRando: p.isRando,
  }))

  await state.publishEvent(code, {
    type: 'round_won',
    winnerId: winnerPlayerId,
    submissionId: winnerSubmissionId,
    scores,
  })
  captureServerEvent(code, 'cab_round_voted', {
    roomCode: code,
    winnerId: winnerPlayerId,
    voteSpread: tally,
  })
  await redis.del(voteTallyKey)
  await endRound(code, Object.keys(submissions))
}

export async function eliminateSubmission(
  code: string,
  byPlayerId: string,
  submissionId: string,
): Promise<void> {
  const submissions = await state.getSubmissions(code)
  const order = await getSubOrder(code)
  const pid = await resolveSubmissionKey(code, submissionId)
  if (!pid || !submissions[pid]) return
  const updated: Submission = { ...submissions[pid], eliminated: true }
  await state.setSubmission(code, pid, updated)

  await state.publishEvent(code, { type: 'card_eliminated', submissionId, byPlayerId })

  const remaining = Object.entries(await state.getSubmissions(code)).filter(
    ([, s]) => !s.eliminated,
  )
  if (remaining.length === 1) {
    const firstRemaining = remaining[0]
    if (!firstRemaining) return
    const [winnerKey] = firstRemaining
    const winnerPlayerId = resolvePlayerId(winnerKey)
    const winner = await state.getPlayer(code, winnerPlayerId)
    if (!winner) return
    const bonus = countGambleTransfers(submissions, winnerPlayerId)
    const gain = 1 + bonus
    await state.updatePlayer(code, winnerPlayerId, { score: winner.score + gain })

    const allPlayers = await state.getAllPlayers(code)
    const scores = allPlayers.map((p) => ({
      playerId: p.id,
      username: p.username,
      score: p.id === winnerPlayerId ? p.score + gain : p.score,
      isJudge: false,
      isRando: p.isRando,
    }))
    await state.publishEvent(code, {
      type: 'round_won',
      winnerId: winnerPlayerId,
      submissionId: publicIdForKey(order, winnerKey),
      scores,
    })
    captureServerEvent(code, 'cab_round_eliminated', {
      roomCode: code,
      winnerId: winnerPlayerId,
      totalEliminations: Object.keys(submissions).length - 1,
    })
    await endRound(code, Object.keys(submissions))
  } else {
    const activePlayers = (await state.getAllPlayers(code)).filter(
      (p) => p.status === 'active' && !p.isRando,
    )
    const currentIdx = activePlayers.findIndex((p) => p.id === byPlayerId)
    const nextPlayer = activePlayers[(currentIdx + 1) % activePlayers.length]
    if (nextPlayer) {
      await state.publishEvent(code, { type: 'elimination_turn', playerId: nextPlayer.id })
    }
  }
}

export async function applyRanking(code: string, czarId: string, ranking: string[]): Promise<void> {
  const submissions = await state.getSubmissions(code)
  const points = [3, 2, 1] as const
  const scoresDelta: Record<string, number> = {}
  const rankedSubmissions: Submission[] = []

  for (let i = 0; i < ranking.length && i < 3; i++) {
    const sid = ranking[i]!
    const key = await resolveSubmissionKey(code, sid)
    if (!key || !submissions[key]) continue
    const pid = resolvePlayerId(key)
    const pts = points[i] ?? 1
    scoresDelta[pid] = pts
    const player = await state.getPlayer(code, pid)
    if (player) await state.updatePlayer(code, pid, { score: player.score + pts })
    rankedSubmissions.push({ ...submissions[key], submissionId: sid, rank: (i + 1) as 1 | 2 | 3 })
  }

  await state.publishEvent(code, { type: 'round_ranked', ranking: rankedSubmissions, scoresDelta })
  captureServerEvent(code, 'cab_round_ranked', {
    roomCode: code,
    top3: rankedSubmissions.map((s) => s.playerId).filter(Boolean),
  })
  await endRound(code, Object.keys(submissions))

  void czarId
}

export async function gamble(code: string, playerId: string): Promise<void> {
  const player = await state.getPlayer(code, playerId)
  if (!player || player.score < 1 || player.hasGambled) return

  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) return
  const [roundRow] = await db
    .select()
    .from(gameRounds)
    .where(eq(gameRounds.sessionId, session.id))
    .orderBy(desc(gameRounds.roundNum))
    .limit(1)
  if (!roundRow) return
  const [black] = await db.select().from(blackCards).where(eq(blackCards.id, roundRow.blackCardId))
  if (!black) return

  await state.updatePlayer(code, playerId, { score: player.score - 1, hasGambled: true })
  const extra = await state.drawCards(code, 'white', black.pick)
  if (extra.length > 0) {
    const current = await state.getHand(code, playerId)
    await state.setHand(code, playerId, [...current, ...extra])
  }
  await state.publishEvent(code, { type: 'player_gambled', playerId })
  captureServerEvent(playerId, 'cab_gambled', { roomCode: code, playerId })
  captureServerEvent(playerId, 'cab_rule_triggered', { roomCode: code, playerId, rule: 'gambling' })
}

export async function redraw(code: string, playerId: string): Promise<void> {
  const player = await state.getPlayer(code, playerId)
  if (!player || player.score < 1) return
  await state.updatePlayer(code, playerId, { score: player.score - 1 })
  const hand = await state.getHand(code, playerId)
  await state.discardCards(code, 'white', hand)
  const newCards = await state.drawCards(code, 'white', 10)
  await state.setHand(code, playerId, newCards)
  captureServerEvent(playerId, 'cab_rule_triggered', {
    roomCode: code,
    playerId,
    rule: 'rebooting',
  })
}

export async function confessDiscard(
  code: string,
  playerId: string,
  cardId: string,
): Promise<void> {
  const player = await state.getPlayer(code, playerId)
  if (!player || player.discardsUsed >= 3) return
  await state.removeFromHand(code, playerId, [cardId])
  await state.discardCards(code, 'white', [cardId])
  const replacement = await state.drawCards(code, 'white', 1)
  if (replacement.length > 0) {
    const current = await state.getHand(code, playerId)
    await state.setHand(code, playerId, [...current, ...replacement])
  }
  await state.updatePlayer(code, playerId, { discardsUsed: player.discardsUsed + 1 })
  captureServerEvent(playerId, 'cab_rule_triggered', {
    roomCode: code,
    playerId,
    rule: 'never_have_i_ever',
  })
}

export async function applyPackingHeat(code: string, playerIds: string[]): Promise<void> {
  for (const pid of playerIds) {
    const extra = await state.drawCards(code, 'white', 1)
    if (extra.length > 0) {
      const current = await state.getHand(code, pid)
      await state.setHand(code, pid, [...current, ...extra])
    }
  }
}
