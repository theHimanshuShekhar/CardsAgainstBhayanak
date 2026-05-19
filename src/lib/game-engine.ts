import { db } from '~/db'
import { blackCards, whiteCards, gameSessions, gamePlayers, gameRounds, packs } from '~/db/schema'
import { inArray, eq, sql, desc, and } from 'drizzle-orm'
import { randomInt, shuffle } from './rng'
import { redis, KEYS, ROOM_TTL_SECONDS } from './redis'
import * as state from './game-state'
import { engineLogger } from './logger'
import { captureServerEvent, distinctIdFor, distinctIdForHost } from './posthog-server'
import { TIMER_MS, REVEAL_STAGGER, ROUND_RESULT_PAUSE_MS } from './timing'
import type {
  GameConfig,
  GameOverMode,
  Submission,
  Card,
  BlackCard,
  GamePlayer,
  PlayerScore,
} from './types'
import { createId } from '@paralleldrive/cuid2'

export function chooseFirstCzar(activePlayerCount: number): number {
  return randomInt(0, activePlayerCount)
}

// Every scores payload (round_won / state_snapshot / game_over) must
// exclude `dropped` players. A player who disconnects past the grace
// window stays in the Redis players hash with a frozen score; if they
// re-join they get a brand-new row (new id, score 0 — join.ts), so the
// same handle would render twice: a stale ghost at the old score and a
// fresh 0pt chip. To an observer that reads as a player's points
// "weirdly reducing". `grace` is kept — a transient disconnect that may
// still return — only the terminal `dropped` is filtered.
export function toPlayerScores(players: GamePlayer[], czarId: string | null): PlayerScore[] {
  return players
    .filter((p) => p.status !== 'dropped')
    .map((p) => ({
      playerId: p.id,
      username: p.username,
      score: p.score,
      isJudge: p.id === czarId,
      isRando: p.isRando,
    }))
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

  // Ordered by joined_at: czarOrder is built from this and the spec
  // requires the stable rotation to follow join order (SPEC.md § Czar
  // selection).
  const activePlayers = await db
    .select()
    .from(gamePlayers)
    .where(
      sql`${gamePlayers.sessionId} = ${session.id} AND ${gamePlayers.role} = 'player' AND ${gamePlayers.status} = 'active'`,
    )
    .orderBy(gamePlayers.joinedAt)

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
    if (rando) {
      activePlayers.push(rando)
      // Mirror into Redis — engine reads players from there, not the DB.
      await state.addPlayer(code, {
        id: rando.id,
        username: rando.username,
        role: 'player',
        status: 'active',
        score: 0,
        isHost: false,
        isRando: true,
        discardsUsed: 0,
        joinedAt: rando.joinedAt.toISOString(),
      })
    }
  }

  const playerIds = activePlayers.map((p) => p.id)
  // czarOrder excludes Rando (synthetic, can't read prompts) and is the
  // *stable* rotation list — never rebuilt from a live array (SPEC.md
  // § Czar selection). playerIds (incl. Rando) is only for hand dealing.
  const czarOrderIds = activePlayers.filter((p) => !p.isRando).map((p) => p.id)
  await state.setCzarOrder(code, czarOrderIds)
  await dealStartingHands(code, playerIds)

  // Round-1 Czar is a random offset into czarOrder; persist it so the
  // rotation is stable and seeded-RNG runs are deterministic.
  const firstCzarIdx = chooseFirstCzar(czarOrderIds.length)
  await redis.hset(KEYS.game(code), 'czarStartOffset', String(firstCzarIdx))
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

  // Happy Ending: the host armed an early end last round — the Haiku card
  // was queued at the deck head, so this round (which just drew it) is the
  // forced final. Promote armed → final; endRound ends the game.
  if (await redis.hget(KEYS.game(code), 'happyEndingArmed')) {
    await redis.hset(KEYS.game(code), 'happyEndingFinal', '1')
    await redis.hdel(KEYS.game(code), 'happyEndingArmed')
  }

  let czarId: string | null = null
  if (forceCzarId !== undefined) {
    czarId = forceCzarId
  } else if (!config.rules.includes('godmode')) {
    // Traverse the *stable* czarOrder — never rebuild it from a live
    // filtered array (that shifts every player's turn when anyone drops).
    // Land on czarOrder[(offset + round - 1) % len], then step forward
    // past players who are `dropped`, keeping every other player's turn
    // fixed (SPEC.md § Czar selection — Drops).
    const order = await state.getCzarOrder(code)
    if (order.length > 0) {
      const allPlayers = await state.getAllPlayers(code)
      const dropped = (pid: string) => allPlayers.find((x) => x.id === pid)?.status === 'dropped'
      const offset = Number(await redis.hget(KEYS.game(code), 'czarStartOffset')) || 0
      let idx = (offset + round - 1) % order.length
      for (let step = 0; step < order.length; step++) {
        const candidate = order[idx]
        if (candidate && !dropped(candidate)) {
          czarId = candidate
          break
        }
        idx = (idx + 1) % order.length
      }
    }
  }

  await state.clearSkippedPlayers(code)
  // S2-9: drop the prior round's winner/ranking/elimination turn so a
  // reconnect during this round's picking phase can't surface a stale
  // outcome in the snapshot.
  await state.clearRoundResolution(code)
  await state.setCurrentRound(code, round)
  await state.setPhase(code, 'picking')

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
  captureServerEvent(await distinctIdForHost(code), 'cab_round_started', {
    roomCode: code,
    round,
    czarId,
    blackCardPick: black.pick,
  })

  if (config.rules.includes('rando')) {
    await autoSubmitRando(code, black.pick)
  }

  if (config.rules.includes('packing_heat') && black.pick === 2) {
    const all = await state.getAllPlayers(code)
    const eligible = all
      .filter((p) => p.status === 'active' && !p.isRando && p.id !== czarId)
      .map((p) => p.id)
    await applyPackingHeat(code, eligible)
  }

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
      captureServerEvent(await distinctIdFor(code, player.id), 'cab_player_skipped', {
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
    // S2-1: return submitted white cards and discard the black card
    // before the replay — a voided round must not leak them out of
    // circulation (this path previously did neither).
    const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
    const [roundRow] = session
      ? await db
          .select()
          .from(gameRounds)
          .where(eq(gameRounds.sessionId, session.id))
          .orderBy(desc(gameRounds.roundNum))
          .limit(1)
      : []
    if (roundRow) await returnRoundCards(code, roundRow.blackCardId)
    await state.clearSubmissions(code)
    await state.clearSkippedPlayers(code)
    // Voided round never resolves: clear wagers so settleGambles doesn't
    // debit these players when a *later* round resolves (deferred debit).
    for (const p of await state.getAllPlayers(code)) {
      if (p.hasGambled) await state.updatePlayer(code, p.id, { hasGambled: false })
    }
    await startRound(code, round + 1, czarId)
    return
  }
  // 2+ submissions: skipped players are excluded, so the round is now ready.
  await checkRoundReady(code)
}

// S2-10: the round timer is a process-local setTimeout — a restart
// mid-round loses it, so a round whose players never submit hangs
// forever (CLAUDE.md: server-controlled phase timing). roundTimerExpiresAt
// is persisted; on boot, re-arm a timer for every active session still
// in `picking` from that expiry, firing immediately if it already
// lapsed during downtime. expireRoundTimer self-guards on a stale round
// number, so a duplicate (vs. a round started just after boot) no-ops.
export async function restoreRoundTimers(): Promise<void> {
  const sessions = await db
    .select({ id: gameSessions.id, code: gameSessions.code })
    .from(gameSessions)
    .where(eq(gameSessions.status, 'active'))
  for (const s of sessions) {
    const { code } = s
    if ((await state.getPhase(code)) !== 'picking') continue
    const expiresAt = await state.getRoundTimerExpiresAt(code)
    if (!expiresAt) continue
    const round = await state.getCurrentRound(code)
    const [roundRow] = await db
      .select({ czarPlayerId: gameRounds.czarPlayerId })
      .from(gameRounds)
      .where(eq(gameRounds.sessionId, s.id))
      .orderBy(desc(gameRounds.roundNum))
      .limit(1)
    const czarId = roundRow?.czarPlayerId ?? null
    const ms = expiresAt - Date.now()
    if (ms <= 0) void expireRoundTimer(code, round, czarId)
    else setTimeout(() => void expireRoundTimer(code, round, czarId), ms)
    engineLogger.info({ code, round, ms: Math.max(0, ms) }, 'round timer restored')
  }
}

// ── Reveal / judging orchestration ────────────────────────────────
//
// The public submissionId is the index into a server-persisted permuted
// order. The submissionId → playerId mapping stays hidden until reveal
// (spec § Submission ordering).
const subOrderKey = (code: string) => `${KEYS.round(code)}:order`
const resolvingKey = (code: string) => `${KEYS.round(code)}:resolving`
const revealedKey = (code: string) => `${KEYS.round(code)}:revealed`
const voteTallyKeyFor = (code: string) => `${KEYS.round(code)}:votetally`
const tieKeyFor = (code: string) => `${KEYS.round(code)}:tiebreak`
const votersKeyFor = (code: string) => `${KEYS.round(code)}:voters`

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// E2E shrinks the round-result beat (CAB_ROUND_RESULT_PAUSE_MS) so the
// suite isn't paced by the 4s production pause; prod uses the constant.
function roundResultPauseMs(): number {
  const override = Number(process.env.CAB_ROUND_RESULT_PAUSE_MS)
  return Number.isFinite(override) && override >= 0 ? override : ROUND_RESULT_PAUSE_MS
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
  const orderJson = JSON.stringify(order)
  await redis.set(subOrderKey(code), orderJson, 'EX', ROOM_TTL_SECONDS)

  await state.setPhase(code, 'reveal')
  await state.publishEvent(code, { type: 'reveal_start' })
  for (let i = 0; i < order.length; i++) {
    const sub = submissions[order[i]!]
    if (!sub) continue
    await sleep(REVEAL_STAGGER)
    // `pick` is not phase-gated: pickWinner → endRound can resolve and
    // advance the round while this loop is still sleeping between
    // staggered reveals. endRound deletes subOrderKey; a fresh round
    // rewrites it with a new order. Either way, emitting more
    // card_revealed frames for a finished round lands them after the
    // client's round_started cleared submissions[], producing a sparse
    // array that crashes the next round's render. Bail the instant this
    // reveal sequence is no longer the live one.
    if ((await redis.get(subOrderKey(code))) !== orderJson) return
    await redis.set(revealedKey(code), String(i + 1), 'EX', ROOM_TTL_SECONDS)
    await state.publishEvent(code, { type: 'card_revealed', submissionIndex: i, fills: sub.fills })
  }

  if (config.rules.includes('survival')) {
    await state.setPhase(code, 'eliminating')
    const turnOrder = players.filter((p) => p.status === 'active' && p.id !== czarId && !p.isRando)
    const firstP = turnOrder[0]
    if (firstP) {
      await redis.hset(KEYS.round(code), 'eliminationTurnPlayerId', firstP.id)
      await redis.expire(KEYS.round(code), ROOM_TTL_SECONDS)
      await state.publishEvent(code, { type: 'elimination_turn', playerId: firstP.id })
    }
  } else if (config.rules.includes('godmode')) {
    await state.setPhase(code, 'waiting')
    await state.publishEvent(code, { type: 'vote_tally', votes: {} })
  } else if (config.rules.includes('serious_business')) {
    await state.setPhase(code, 'ranking')
  } else {
    await state.setPhase(code, 'judging')
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
  captureServerEvent(await distinctIdFor(code, playerId), 'cab_card_played', {
    roomCode: code,
    playerId,
    pickCount: cardIds.length,
  })
  await checkRoundReady(code)
}

// Rando Cardrissian: a synthetic player that auto-plays each round by
// drawing straight from the white deck (it has no hand). Submitted at
// round start so it's just another anonymous submission to judge/vote.
export async function autoSubmitRando(code: string, pick: number): Promise<void> {
  const players = await state.getAllPlayers(code)
  const rando = players.find((p) => p.isRando && p.status === 'active')
  if (!rando) return
  const drawn = await state.drawCards(code, 'white', pick)
  if (drawn.length === 0) return
  const rows = await db.select().from(whiteCards).where(inArray(whiteCards.id, drawn))
  const fills: Card[] = drawn.map((id) => {
    const c = rows.find((x) => x.id === id)
    return c ? { id: c.id, text: c.text } : { id, text: '' }
  })
  const submission: Submission = { submissionId: createId(), fills, playerId: rando.id }
  await state.setSubmission(code, rando.id, submission)
  await state.publishEvent(code, { type: 'player_played', playerId: rando.id })
  captureServerEvent(await distinctIdForHost(code), 'cab_rule_triggered', {
    roomCode: code,
    rule: 'rando',
  })
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
  // Read winner score before settling so the failed-gambler debits (which
  // skip the winner) don't race the winner's own credit.
  const transfer = await settleGambles(code, winnerPlayerId)
  await state.updatePlayer(code, winnerPlayerId, { score: winner.score + 1 + transfer })

  const players = await state.getAllPlayers(code)
  const scores = toPlayerScores(players, czarId)

  await state.setRoundWinner(code, winnerPlayerId)
  await state.publishEvent(code, {
    type: 'round_won',
    winnerId: winnerPlayerId,
    submissionId,
    scores,
  })
  captureServerEvent(await distinctIdFor(code, czarId), 'cab_winner_picked', {
    roomCode: code,
    winnerId: winnerPlayerId,
    isRando: winner.isRando,
  })
  await persistRoundOutcome(code, {
    winnerPlayerId,
    winningFills: submissions[winnerKey]!.fills,
  })
  await endRound(code, Object.keys(submissions))
}

// Round outcomes live in Redis during play; the game_rounds row is
// inserted at round start with only structural fields. Without this
// write-back winner_player_id / winning_submission_fills stay NULL
// forever, so /api/stats counts every round ever *started* (not judged)
// and Top cards is permanently empty. Called from every judged path
// (normal / God Is Dead / Survival / Serious Business) just before
// endRound; voided rounds never reach here, so they correctly stay
// unjudged.
async function persistRoundOutcome(
  code: string,
  outcome: {
    winnerPlayerId: string | null
    winningFills: Card[]
    ranking?: Submission[]
    voteTally?: Record<string, number>
  },
): Promise<void> {
  const [session] = await db
    .select({ id: gameSessions.id })
    .from(gameSessions)
    .where(eq(gameSessions.code, code))
  if (!session) return
  const round = await state.getCurrentRound(code)
  await db
    .update(gameRounds)
    .set({
      winnerPlayerId: outcome.winnerPlayerId,
      winningSubmissionFills: outcome.winningFills,
      ...(outcome.ranking !== undefined ? { ranking: outcome.ranking } : {}),
      ...(outcome.voteTally !== undefined ? { voteTally: outcome.voteTally } : {}),
    })
    .where(and(eq(gameRounds.sessionId, session.id), eq(gameRounds.roundNum, round)))
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
  await redis.del(
    subOrderKey(code),
    resolvingKey(code),
    revealedKey(code),
    voteTallyKeyFor(code),
    tieKeyFor(code),
    votersKeyFor(code),
  )

  const players = await state.getAllPlayers(code)
  // Clear gamble flag for all players who gambled this round
  for (const p of players) {
    if (p.hasGambled) await state.updatePlayer(code, p.id, { hasGambled: false })
  }
  const activated: string[] = []
  for (const p of players) {
    if (p.status === 'queued') {
      await state.updatePlayer(code, p.id, { status: 'active' })
      await state.appendCzarOrder(code, p.id)
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

  await state.setPhase(code, 'transition')
  await state.publishEvent(code, { type: 'round_end', activatedPlayers: activated, handsRefilled })

  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) return
  const config = session.config as GameConfig
  const refreshed = await state.getAllPlayers(code)

  // Happy Ending: this was the forced "Make a Haiku" final round —
  // end now regardless of score; the current leader wins.
  if (await redis.hget(KEYS.game(code), 'happyEndingFinal')) {
    await redis.hdel(KEYS.game(code), 'happyEndingFinal', 'happyEndingArmed')
    const leader = [...refreshed].sort((a, b) => b.score - a.score)[0]
    await endGame(code, 'happy_ending', leader?.id)
    return
  }

  const winnerPlayer = refreshed.find((p) => p.score >= config.roundsToWin)
  if (winnerPlayer) {
    await endGame(code, winnerPlayer.isRando ? 'rando_won' : 'normal', winnerPlayer.id)
    return
  }

  // Hold on the resolved round (winner highlighted via round_won, hands
  // already refilled via round_end) before the next round_started wipes
  // the board. Server-driven so it can't be raced by an immediate
  // round_started — the bug where the winner never showed. Game-over
  // paths returned above, so the end screen is unaffected.
  await sleep(roundResultPauseMs())

  const nextRound = (await state.getCurrentRound(code)) + 1
  await startRound(code, nextRound)
}

export async function endGame(code: string, mode: GameOverMode, winnerId?: string): Promise<void> {
  const players = await state.getAllPlayers(code)
  const finalScores = toPlayerScores(players, null)

  const [updated] = await db
    .update(gameSessions)
    .set({ status: 'ended', endedAt: new Date(), endMode: mode, winnerPlayerId: winnerId ?? null })
    .where(eq(gameSessions.code, code))
    .returning({ createdAt: gameSessions.createdAt })

  await state.publishEvent(code, { type: 'game_over', finalScores, winnerId: winnerId ?? '', mode })

  // game_over carries no totalRounds/durationMs; the server is the only
  // place with authoritative values, so cab_game_ended is emitted here.
  const totalRounds = await state.getCurrentRound(code)
  captureServerEvent(await distinctIdForHost(code), 'cab_game_ended', {
    roomCode: code,
    mode,
    winnerId: winnerId ?? '',
    totalRounds,
    durationMs: updated ? Date.now() - updated.createdAt.getTime() : 0,
    finalScores,
  })
  engineLogger.info({ code, mode, winnerId }, 'game over')
}

// S2-1: return every submitted white card to its submitter's hand and
// discard the round's black card (no reshuffle, per spec). Shared by
// voidRound and the timer-expiry void path so a voided round never leaks
// cards out of circulation. Rando has no hand, so its cards just vanish.
async function returnRoundCards(code: string, blackCardId: string): Promise<void> {
  const submissions = await state.getSubmissions(code)
  for (const [key, sub] of Object.entries(submissions)) {
    const pid = resolvePlayerId(key)
    const p = await state.getPlayer(code, pid)
    if (!p || p.isRando) continue
    const current = await state.getHand(code, pid)
    await state.setHand(code, pid, [...current, ...sub.fills.map((f) => f.id)])
  }
  await state.discardCards(code, 'black', [blackCardId])
}

// S2-1: the current Czar dropped mid-round and can no longer resolve it.
// Discard the round entirely — return every submitted white card to its
// submitter's hand, discard the black card (no reshuffle, per spec), wipe
// round-scoped state — then replay. The dropped Czar is already
// status=dropped, so startRound's normal rotation skips them: the next
// active player becomes Czar.
export async function voidRound(code: string, reason: string): Promise<void> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session || session.status !== 'active') return

  const [roundRow] = await db
    .select()
    .from(gameRounds)
    .where(eq(gameRounds.sessionId, session.id))
    .orderBy(desc(gameRounds.roundNum))
    .limit(1)
  if (!roundRow) return
  const round = roundRow.roundNum

  await returnRoundCards(code, roundRow.blackCardId)
  await state.clearSubmissions(code)
  await state.clearSkippedPlayers(code)
  // Voided round never resolves: clear wagers so settleGambles doesn't
  // debit these players when a *later* round resolves (deferred debit).
  for (const p of await state.getAllPlayers(code)) {
    if (p.hasGambled) await state.updatePlayer(code, p.id, { hasGambled: false })
  }
  await redis.hdel(KEYS.round(code), 'eliminationTurnPlayerId')
  await redis.del(
    subOrderKey(code),
    resolvingKey(code),
    revealedKey(code),
    voteTallyKeyFor(code),
    tieKeyFor(code),
    votersKeyFor(code),
  )

  await state.publishEvent(code, { type: 'round_voided', round, reason })
  engineLogger.info({ code, round, reason }, 'round voided')

  await startRound(code, round + 1)
}

// S2-1: the host dropped. Hand the host role to the longest-present
// active human so host-only actions (Happy Ending, etc.) keep working.
// Returns the new host id, or null if nobody is left to take it.
export async function migrateHost(code: string): Promise<string | null> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) return null

  const players = await state.getAllPlayers(code)
  const next = players
    .filter((p) => p.status === 'active' && p.role === 'player' && !p.isRando)
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0]
  if (!next) return null

  for (const p of players) {
    if (p.isHost && p.id !== next.id) await state.updatePlayer(code, p.id, { isHost: false })
  }
  await state.updatePlayer(code, next.id, { isHost: true })
  await redis.hset(KEYS.game(code), 'hostId', next.id)
  await redis.expire(KEYS.game(code), ROOM_TTL_SECONDS)

  await db
    .update(gameSessions)
    .set({ hostPlayerId: next.id })
    .where(eq(gameSessions.id, session.id))
  await db.update(gamePlayers).set({ isHost: false }).where(eq(gamePlayers.sessionId, session.id))
  await db.update(gamePlayers).set({ isHost: true }).where(eq(gamePlayers.id, next.id))

  await state.publishEvent(code, { type: 'host_changed', hostId: next.id })
  engineLogger.info({ code, newHostId: next.id }, 'host migrated')
  return next.id
}

// S2-1: when every human player has dropped, there is no one left to
// resolve or advance the round. Park the session in 'paused' so the
// 6h stale-game sweeper can later abandon it. The 'paused' status also
// makes voidRound/migrateHost no-ops (their `status !== 'active'`
// guard), suppressing pointless work on a deserted room.
export async function pauseGame(code: string): Promise<void> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session || session.status !== 'active') return
  await db.update(gameSessions).set({ status: 'paused' }).where(eq(gameSessions.id, session.id))
  await redis.hset(KEYS.game(code), 'status', 'paused')
  await redis.expire(KEYS.game(code), ROOM_TTL_SECONDS)
  engineLogger.info({ code }, 'all players dropped — game paused')
}

// S2-8: pauseGame parks a deserted room; nothing un-parks it, so a
// rejoiner is stranded until the 6h sweeper abandons it. A fresh joiner
// arrives via POST /join as a *new* player (their old session was
// cleared on player_dropped), so join.ts calls this after addPlayer.
// Resume only once ≥3 present humans exist — the same minimum start.ts
// enforces to begin a game — then activate anyone the pause/queue path
// left without a hand or a czarOrder slot and void the stuck round (its
// Czar is a dropped player and can never resolve it) so a present
// player Czars a fresh one.
export async function resumeIfReady(code: string): Promise<void> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session || session.status !== 'paused') return

  const players = await state.getAllPlayers(code)
  const humans = players.filter((p) => p.role === 'player' && !p.isRando && p.status !== 'dropped')
  if (humans.length < 3) return

  // Activate every present human the pause/queue path left un-set-up
  // (the new joiner; any stranded queued player). Mirrors endRound's
  // queued→active activation: Redis-only, like the rest of the engine.
  const inOrder = new Set(await state.getCzarOrder(code))
  for (const p of humans) {
    if (p.status !== 'active') await state.updatePlayer(code, p.id, { status: 'active' })
    if (!inOrder.has(p.id)) {
      await state.appendCzarOrder(code, p.id)
      await state.setHand(code, p.id, await state.drawCards(code, 'white', 10))
    }
  }

  // Flip active *before* voidRound — it (and startRound's downstream
  // helpers) no-op unless the session is 'active'.
  await db.update(gameSessions).set({ status: 'active' }).where(eq(gameSessions.id, session.id))
  await redis.hset(KEYS.game(code), 'status', 'active')
  await redis.expire(KEYS.game(code), ROOM_TTL_SECONDS)
  engineLogger.info({ code, humans: humans.length }, 'game resumed from pause')

  await voidRound(code, 'resumed after pause')
}

// S2-5/S2-6: the canonical "remove a player from a live game" path,
// shared by the grace-timeout drop (WS close), the explicit WS `leave`
// message, and the HTTP /leave beacon. Idempotent — a `leave` followed
// by the socket close (or a double beacon) must not double-emit
// player_left or re-void/re-migrate/re-pause. This is the logic the
// close-handler grace timeout used to run inline.
export async function dropPlayer(
  code: string,
  playerId: string,
  reason: 'grace' | 'leave',
): Promise<void> {
  const player = await state.getPlayer(code, playerId)
  if (!player || player.status === 'dropped') return

  await state.updatePlayer(code, playerId, { status: 'dropped' })
  await state.publishEvent(code, { type: 'player_left', playerId })
  captureServerEvent(await distinctIdFor(code, playerId), 'cab_player_dropped', {
    roomCode: code,
    playerId,
    reason,
  })

  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (session?.status !== 'active') return

  // No human left to resolve/advance the round → pause (the 6h sweeper
  // abandons it later). Skip migrate/void: no-ops on a deserted room
  // that would just churn the event loop.
  const players = await state.getAllPlayers(code)
  const activeHumans = players.filter(
    (p) => p.status === 'active' && p.role === 'player' && !p.isRando,
  )
  if (activeHumans.length === 0) {
    await pauseGame(code)
    return
  }

  // Host left → hand the role to the longest-present active player so
  // host-only actions (Happy Ending, etc.) keep working.
  if (session.hostPlayerId === playerId) {
    await migrateHost(code)
  }

  // Czar of a live round left → it can no longer be resolved; void it
  // and rotate to the next Czar. phase null/'transition' ⇒ no round is
  // mid-flight, so nothing to void.
  const [roundRow] = await db
    .select()
    .from(gameRounds)
    .where(eq(gameRounds.sessionId, session.id))
    .orderBy(desc(gameRounds.roundNum))
    .limit(1)
  const phase = await state.getPhase(code)
  if (roundRow?.czarPlayerId === playerId && phase && phase !== 'transition') {
    await voidRound(code, 'czar_dropped')
  }
}

// ── House rule mechanics ──────────────────────────────────────────

// Gamble submissions are stored under `${playerId}:gamble` in the submissions hash.
function resolvePlayerId(key: string): string {
  return key.endsWith(':gamble') ? key.slice(0, -7) : key
}

// Settles the gambling point-transfer for a resolved round. The wagered
// point is *not* debited at `gamble()` time — it is debited here, so a
// round that voids (never calls this) correctly leaves wagers intact.
// Keyed off the authoritative `hasGambled` player flag rather than
// submission keys, so it is correct even if a gambler submitted 0 or 1
// times instead of 2 (S3-2). Every player who wagered and did *not* win
// forfeits their point to the round winner; a winning gambler keeps
// their point (no debit). Returns the points the winner gains from
// forfeited wagers (the +1 win bonus is added by the caller).
async function settleGambles(code: string, winnerPlayerId: string): Promise<number> {
  const players = await state.getAllPlayers(code)
  let transfer = 0
  for (const p of players) {
    if (!p.hasGambled || p.id === winnerPlayerId) continue
    await state.updatePlayer(code, p.id, { score: Math.max(0, p.score - 1) })
    transfer += 1
  }
  return transfer
}

export async function castVote(code: string, voterId: string, submissionId: string): Promise<void> {
  const voteTallyKey = voteTallyKeyFor(code)
  const tieKey = tieKeyFor(code)
  const votersKey = votersKeyFor(code)

  // Can't vote for your own submission (God Is Dead house rule).
  const votedKey = await resolveSubmissionKey(code, submissionId)
  if (!votedKey) return
  if (resolvePlayerId(votedKey) === voterId) return

  // One vote per player per round.
  const fresh = await redis.sadd(votersKey, voterId)
  await redis.expire(votersKey, ROOM_TTL_SECONDS)
  if (fresh === 0) return

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
      await redis.del(voteTallyKey, votersKey)
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
  const transfer = await settleGambles(code, winnerPlayerId)
  await state.updatePlayer(code, winnerPlayerId, { score: winner.score + 1 + transfer })

  const allPlayers = await state.getAllPlayers(code)
  const scores = toPlayerScores(allPlayers, null)

  await state.setRoundWinner(code, winnerPlayerId)
  await state.publishEvent(code, {
    type: 'round_won',
    winnerId: winnerPlayerId,
    submissionId: winnerSubmissionId,
    scores,
  })
  captureServerEvent(await distinctIdForHost(code), 'cab_round_voted', {
    roomCode: code,
    winnerId: winnerPlayerId,
    voteSpread: tally,
  })
  await redis.del(voteTallyKey)
  await persistRoundOutcome(code, {
    winnerPlayerId,
    winningFills: submissions[winnerKey]?.fills ?? [],
    voteTally: tally,
  })
  await endRound(code, Object.keys(submissions))
}

export async function eliminateSubmission(
  code: string,
  byPlayerId: string,
  submissionId: string,
): Promise<void> {
  // Only the player whose turn it is may eliminate (Survival).
  const turnPlayerId = await redis.hget(KEYS.round(code), 'eliminationTurnPlayerId')
  if (turnPlayerId && byPlayerId !== turnPlayerId) return

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
    const transfer = await settleGambles(code, winnerPlayerId)
    await state.updatePlayer(code, winnerPlayerId, { score: winner.score + 1 + transfer })

    const allPlayers = await state.getAllPlayers(code)
    const scores = toPlayerScores(allPlayers, null)
    await state.setRoundWinner(code, winnerPlayerId)
    await state.publishEvent(code, {
      type: 'round_won',
      winnerId: winnerPlayerId,
      submissionId: publicIdForKey(order, winnerKey),
      scores,
    })
    captureServerEvent(await distinctIdForHost(code), 'cab_round_eliminated', {
      roomCode: code,
      winnerId: winnerPlayerId,
      totalEliminations: Object.keys(submissions).length - 1,
    })
    await persistRoundOutcome(code, {
      winnerPlayerId,
      winningFills: submissions[winnerKey]?.fills ?? [],
    })
    await endRound(code, Object.keys(submissions))
  } else {
    // Same turn set as checkRoundReady's Survival branch: active, not
    // rando, not the Czar.
    const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
    const [roundRow] = session
      ? await db
          .select()
          .from(gameRounds)
          .where(eq(gameRounds.sessionId, session.id))
          .orderBy(desc(gameRounds.roundNum))
          .limit(1)
      : []
    const czarId = roundRow?.czarPlayerId ?? null
    const activePlayers = (await state.getAllPlayers(code)).filter(
      (p) => p.status === 'active' && !p.isRando && p.id !== czarId,
    )
    const currentIdx = activePlayers.findIndex((p) => p.id === byPlayerId)
    const nextPlayer = activePlayers[(currentIdx + 1) % activePlayers.length]
    if (nextPlayer) {
      // Persist the turn so it survives reconnects, not just broadcast.
      await redis.hset(KEYS.round(code), 'eliminationTurnPlayerId', nextPlayer.id)
      await redis.expire(KEYS.round(code), ROOM_TTL_SECONDS)
      await state.publishEvent(code, { type: 'elimination_turn', playerId: nextPlayer.id })
    }
  }
}

export async function applyRanking(code: string, czarId: string, ranking: string[]): Promise<void> {
  const submissions = await state.getSubmissions(code)
  const points = [3, 2, 1] as const
  const scoresDelta: Record<string, number> = {}
  const rankedSubmissions: Submission[] = []
  // Serious Business has no single Czar pick — winner_player_id is the
  // top-ranked submission's player (SPEC.md § Serious Business).
  let topWinnerId: string | null = null
  let topFills: Card[] = []

  for (let i = 0; i < ranking.length && i < 3; i++) {
    const sid = ranking[i]!
    const key = await resolveSubmissionKey(code, sid)
    if (!key || !submissions[key]) continue
    const pid = resolvePlayerId(key)
    const pts = points[i] ?? 1
    scoresDelta[pid] = pts
    const player = await state.getPlayer(code, pid)
    if (player) await state.updatePlayer(code, pid, { score: player.score + pts })
    if (rankedSubmissions.length === 0) {
      topWinnerId = pid
      topFills = submissions[key].fills
    }
    rankedSubmissions.push({ ...submissions[key], submissionId: sid, rank: (i + 1) as 1 | 2 | 3 })
  }

  await state.setRoundRanking(code, rankedSubmissions)
  await state.publishEvent(code, { type: 'round_ranked', ranking: rankedSubmissions, scoresDelta })
  captureServerEvent(await distinctIdForHost(code), 'cab_round_ranked', {
    roomCode: code,
    top3: rankedSubmissions.map((s) => s.playerId).filter(Boolean),
  })
  await persistRoundOutcome(code, {
    winnerPlayerId: topWinnerId,
    winningFills: topFills,
    ranking: rankedSubmissions,
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

  // Eligibility (score >= 1) is checked above; the wagered point is debited
  // at round resolution (settleGambles), not here, so a voided round leaves
  // the wager intact.
  await state.updatePlayer(code, playerId, { hasGambled: true })
  const extra = await state.drawCards(code, 'white', black.pick)
  if (extra.length > 0) {
    const current = await state.getHand(code, playerId)
    await state.setHand(code, playerId, [...current, ...extra])
  }
  await state.publishEvent(code, { type: 'player_gambled', playerId })
  const gamblerDistinctId = await distinctIdFor(code, playerId)
  captureServerEvent(gamblerDistinctId, 'cab_gambled', {
    roomCode: code,
    round: roundRow.roundNum,
    playerId,
  })
  captureServerEvent(gamblerDistinctId, 'cab_rule_triggered', {
    roomCode: code,
    playerId,
    rule: 'gambling',
  })
}

export async function redraw(code: string, playerId: string): Promise<void> {
  const player = await state.getPlayer(code, playerId)
  if (!player || player.score < 1) return
  await state.updatePlayer(code, playerId, { score: player.score - 1 })
  const hand = await state.getHand(code, playerId)
  await state.discardCards(code, 'white', hand)
  const newCards = await state.drawCards(code, 'white', 10)
  await state.setHand(code, playerId, newCards)
  captureServerEvent(await distinctIdFor(code, playerId), 'cab_rule_triggered', {
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
  captureServerEvent(await distinctIdFor(code, playerId), 'cab_rule_triggered', {
    roomCode: code,
    playerId,
    rule: 'never_have_i_ever',
  })
}

export async function applyPackingHeat(code: string, playerIds: string[]): Promise<void> {
  for (const pid of playerIds) {
    const extra = await state.drawCards(code, 'white', 1)
    if (extra.length === 0) continue
    const current = await state.getHand(code, pid)
    const newIds = [...current, ...extra]
    await state.setHand(code, pid, newIds)
    // Push the +1 hand to the owning player (round_started can't carry
    // per-player hands; the handler routes hand_update privately).
    const rows = await db.select().from(whiteCards).where(inArray(whiteCards.id, newIds))
    const hand: Card[] = newIds.map((id) => {
      const c = rows.find((x) => x.id === id)
      return c ? { id: c.id, text: c.text } : { id, text: '' }
    })
    await state.publishEvent(code, { type: 'hand_update', playerId: pid, hand })
  }
}

// Happy Ending: host ends the game early. Queues the synthetic "Make a
// Haiku" black card as the next prompt and arms the forced final round.
// The current round finishes normally; the next round is the Haiku round,
// after which endRound ends the game (current leader wins) regardless of
// score.
export async function triggerHappyEnding(code: string, playerId: string): Promise<void> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) return
  if (session.status !== 'active') return
  if (session.hostPlayerId !== playerId) return
  const config = session.config as GameConfig
  if (!config.rules.includes('happy_ending')) return
  // Idempotent: ignore repeat triggers once armed.
  if (await redis.hget(KEYS.game(code), 'happyEndingArmed')) return

  const [haiku] = await db
    .select({ id: blackCards.id })
    .from(blackCards)
    .innerJoin(packs, eq(blackCards.packId, packs.id))
    .where(eq(packs.slug, 'haiku-final'))
    .limit(1)
  if (!haiku) {
    engineLogger.error({ code }, 'happy ending: Haiku card not seeded')
    return
  }

  // Queue the Haiku card as the very next black draw (deck is LPOP-drawn).
  await redis.lpush(KEYS.deckBlack(code), haiku.id)
  await redis.hset(KEYS.game(code), 'happyEndingArmed', '1')
  await redis.expire(KEYS.game(code), ROOM_TTL_SECONDS)
  engineLogger.info({ code, playerId }, 'happy ending armed')
  captureServerEvent(await distinctIdFor(code, playerId), 'cab_rule_triggered', {
    roomCode: code,
    playerId,
    rule: 'happy_ending',
  })
}
