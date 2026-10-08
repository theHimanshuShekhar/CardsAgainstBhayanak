import { db } from '~/db'
import { blackCards, whiteCards, gameSessions, gamePlayers, gameRounds, packs } from '~/db/schema'
import { inArray, eq, sql, desc, and } from 'drizzle-orm'
import { randomInt, shuffle, pick } from './rng'
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
  ResetMode,
} from './types'
import { createId } from '@paralleldrive/cuid2'
import { GameCommandError } from './game-command-error'

export function chooseFirstCzar(activePlayerCount: number): number {
  return randomInt(0, activePlayerCount)
}

// S1-NEW: gameSessions.last_activity_at heartbeat. Without this the
// sweeper's 6h filter compares against the row's creation time forever
// and only the `hlen(players) === 0` safety net keeps live games out of
// the 'abandoned' bucket. Called from every gameplay anchor that signals
// real activity; cheap (one HSET + one indexed UPDATE).
export async function touchSessionActivity(code: string): Promise<void> {
  const now = Date.now()
  await state.updateLiveRoom(code, { lastActivityAt: String(now) })
  await db
    .update(gameSessions)
    .set({ lastActivityAt: new Date(now) })
    .where(eq(gameSessions.code, code))
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

// #8: collapse cross-pack duplicate cards. Keys on the normalized text
// (trimmed, lowercased) and keeps the first occurrence's id; order is
// otherwise preserved (the caller shuffles afterward).
export function dedupeCardIdsByText<T extends { id: string; text: string }>(rows: T[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const r of rows) {
    const key = r.text.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    ids.push(r.id)
  }
  return ids
}

export async function buildDecks(code: string, packIds: string[]): Promise<void> {
  const black = await db.select().from(blackCards).where(inArray(blackCards.packId, packIds))
  const white = await db.select().from(whiteCards).where(inArray(whiteCards.packId, packIds))
  // #8: the same prompt/answer sourced from multiple RAH packs is stored
  // as distinct (pack_id, text) rows, so a multi-pack game would deal
  // visibly duplicate cards. Dedupe each list by normalized text before
  // the existing shuffle.
  const blackIds = shuffle(dedupeCardIdsByText(black))
  const whiteIds = shuffle(dedupeCardIdsByText(white))
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

export async function startGame(code: string, hostPlayerId?: string): Promise<void> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) throw new Error('session not found')
  const config = session.config as GameConfig

  await state.updateLiveRoom(code, {}, hostPlayerId)
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
  await state.updateLiveRoom(code, { czarStartOffset: String(firstCzarIdx) }, hostPlayerId)
  await db
    .update(gameSessions)
    .set({ status: 'active', lastActivityAt: new Date() })
    .where(eq(gameSessions.id, session.id))
  // Lobby edits live in PostgreSQL. Freeze that authoritative config in
  // Redis before accepting game actions that validate rules atomically.
  await state.updateLiveRoom(
    code,
    { status: 'active', config: JSON.stringify(config) },
    hostPlayerId,
  )

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

  // Happy Ending: the host armed an early end. Resolve the Haiku card
  // here (not via deck LPUSH/LPOP) so the trigger is order-independent —
  // a slow `happy_ending` WS message that lands between rounds can't
  // race past the next LPOP and end up drawing the Haiku two rounds late
  // (E2E flake: rule-happy-ending). The flag → final promotion happens
  // atomically inside startRound, so the next round IS the Haiku round
  // whenever the flag was set before this call.
  let black: typeof blackCards.$inferSelect | undefined
  const armed = await redis.hget(KEYS.game(code), 'happyEndingArmed')
  if (armed) {
    const [haiku] = await db
      .select()
      .from(blackCards)
      .innerJoin(packs, eq(blackCards.packId, packs.id))
      .where(eq(packs.slug, 'haiku-final'))
      .limit(1)
    if (haiku) {
      black = haiku.black_cards
      await state.updateLiveRoom(code, { happyEndingFinal: '1' })
      await redis.hdel(KEYS.game(code), 'happyEndingArmed')
    } else {
      engineLogger.error({ code }, 'happy_ending: armed but Haiku card not seeded; falling back')
    }
  }

  if (!black) {
    const blackIds = await state.drawCards(code, 'black', 1)
    if (blackIds.length === 0) {
      await endGame(code, 'deck_exhausted')
      throw new Error('deck_exhausted')
    }
    const [row] = await db
      .select()
      .from(blackCards)
      .where(eq(blackCards.id, blackIds[0] ?? ''))
    if (!row) throw new Error('black card missing')
    black = row
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
  const [roundRow] = await db
    .insert(gameRounds)
    .values({
      sessionId: session.id,
      roundNum: round,
      blackCardId: black.id,
      czarPlayerId: czarId ?? undefined,
    })
    .onConflictDoNothing()
    .returning({ id: gameRounds.id })
  if (!roundRow) throw new Error('round already exists')
  await redis.hset(KEYS.round(code), {
    roundId: roundRow.id,
    czarId: czarId ?? '',
    phase: 'picking',
  })
  await redis.expire(KEYS.round(code), ROOM_TTL_SECONDS)
  await touchSessionActivity(code)

  // Arm the round timer before announcing the round so round_started can
  // carry the authoritative expiry for the client's display-only countdown.
  let roundTimerExpiresAt: number | null = null
  if (config.timer !== 'Off') {
    const ms = TIMER_MS[config.timer]
    roundTimerExpiresAt = Date.now() + ms
    await state.setRoundTimerExpiresAt(code, roundTimerExpiresAt)
    const armedAt = roundTimerExpiresAt
    // Swallow rejections inside the timer callback. The session row can
    // vanish between this insert and a later FK insert when the test
    // suite's globalTeardown TRUNCATEs while orphaned timers are still
    // queued; an unhandled rejection from setTimeout crashes the process.
    // Treating these as no-ops is correct: a missing session means the
    // game is gone, so there's nothing for the timer to drive forward.
    setTimeout(() => {
      expireRoundTimer(code, round, czarId, armedAt).catch((err) =>
        engineLogger.warn({ err, code, round }, 'round timer expiry suppressed'),
      )
    }, ms)
  } else {
    await redis.hdel(KEYS.round(code), 'roundTimerExpiresAt')
  }

  const startProgress = await submissionProgress(code)
  await state.publishEvent(code, {
    type: 'round_started',
    round,
    prompt: { id: black.id, text: black.text, pick: black.pick },
    czarId,
    submitted: startProgress.submitted,
    expected: startProgress.expected,
    roundTimerExpiresAt,
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

  engineLogger.info({ code, round, czarId, blackCardId: black.id }, 'round started')
  return { prompt: { id: black.id, text: black.text, pick: black.pick } as BlackCard, czarId }
}

export async function expireRoundTimer(
  code: string,
  round: number,
  czarId: string | null,
  armedAt: number | null,
): Promise<void> {
  // Guard 1: round already advanced past this timer.
  const currentRound = await state.getCurrentRound(code)
  if (currentRound !== round) return

  // Guard 2 (S3-NEW-A): the persisted expiry no longer matches ours. A
  // setTimeout queued for the old game's round N can otherwise fire inside
  // a rematch's round N (resetGame zeroes currentRound first, but startGame
  // immediately re-stamps it back to round 1) and force-voids the new
  // round. A non-null `armedAt` means the timer was armed at a known epoch
  // ms; if persisted is null (round hash wiped by reset) or different
  // (round armed a fresh timer), this is a stale callback. The legacy
  // restoreRoundTimers path passes null and skips this guard, since the
  // re-armed timer IS by definition the authoritative one.
  if (armedAt !== null) {
    const persisted = await state.getRoundTimerExpiresAt(code)
    if (persisted !== armedAt) return
  }

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
      const skipProgress = await submissionProgress(code)
      await state.publishEvent(code, {
        type: 'player_skipped',
        playerId: player.id,
        round,
        submitted: skipProgress.submitted,
        expected: skipProgress.expected,
      })
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

// S2-10 + S2-NEW: on boot, sweep every active session for in-flight
// process-local awaits that died with the previous process and resume
// them. Three cases:
//   1. phase='picking' with a persisted roundTimerExpiresAt → re-arm
//      the round-timeout setTimeout (S2-10).
//   2. phase='transition' with a persisted postResolveResumeAt → schedule
//      finalizeRoundAfterPause (the 4s ROUND_RESULT_PAUSE_MS that the
//      previous process was sleeping through when it died) (S2-NEW).
//   3. phase='reveal' → fast-forward through the staggered reveal loop's
//      tail: skip remaining card_revealed publishes (clients resync via
//      rejoin's state_snapshot) and run transitionAfterReveal so the
//      round can hand off to the Czar / vote / elimination phase (S2-NEW).
// All three callees are guarded against duplicate calls.
export async function restoreRoundTimers(): Promise<void> {
  const sessions = await db
    .select({ id: gameSessions.id, code: gameSessions.code, config: gameSessions.config })
    .from(gameSessions)
    .where(eq(gameSessions.status, 'active'))
  for (const s of sessions) {
    const { code } = s
    const currentRound = await state.getCurrentRound(code)
    const [currentRow] = await db
      .select()
      .from(gameRounds)
      .where(and(eq(gameRounds.sessionId, s.id), eq(gameRounds.roundNum, currentRound)))
    if (
      !currentRow ||
      !(await state.ensureRoundIdentity(code, currentRound, currentRow.id, currentRow.czarPlayerId))
    )
      continue
    const phase = await state.getPhase(code)

    // Case 1 — picking-phase round timer (S2-10)
    if (phase === 'picking') {
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
      // armedAt=null bypasses the persisted-expiry guard: the boot-restore
      // path IS the authoritative re-arm, and the persisted value is what
      // we just read, so a match-check would be tautological.
      const onExpire = (): void => {
        expireRoundTimer(code, round, czarId, null).catch((err) =>
          engineLogger.warn({ err, code, round }, 'round timer expiry suppressed'),
        )
      }
      if (ms <= 0) onExpire()
      else setTimeout(onExpire, ms)
      engineLogger.info({ code, round, ms: Math.max(0, ms) }, 'round timer restored')
      continue
    }

    // Case 2 — post-resolve pause (S2-NEW)
    if (phase === 'transition') {
      const resumeAt = await state.getPostResolveResumeAt(code)
      if (!resumeAt) continue // not a finalize-pending transition (no-op)
      const ms = resumeAt - Date.now()
      const onResume = (): void => {
        finalizeRoundAfterPause(code).catch((err) =>
          engineLogger.warn({ err, code }, 'post-resolve pause suppressed'),
        )
      }
      if (ms <= 0) onResume()
      else setTimeout(onResume, ms)
      engineLogger.info({ code, ms: Math.max(0, ms) }, 'post-resolve pause restored')
      continue
    }

    // Case 3 — reveal-loop interrupted mid-stagger (S2-NEW). The post-loop
    // transition (set next phase + publish elimination_turn / vote_tally)
    // never ran, so the Czar has no signal to act. Fast-forward: skip the
    // remaining REVEAL_STAGGER beats and run transitionAfterReveal now.
    // Clients reconnecting via rejoin pick up the missed card_revealed
    // events from the snapshot's submissions array.
    if (phase === 'reveal') {
      const [roundRow] = await db
        .select({ czarPlayerId: gameRounds.czarPlayerId })
        .from(gameRounds)
        .where(eq(gameRounds.sessionId, s.id))
        .orderBy(desc(gameRounds.roundNum))
        .limit(1)
      const czarId = roundRow?.czarPlayerId ?? null
      const players = await state.getAllPlayers(code)
      const config = s.config as GameConfig
      void transitionAfterReveal(code, config, czarId, players).catch((err) =>
        engineLogger.error({ err, code }, 'reveal fast-forward failed'),
      )
      engineLogger.info({ code }, 'reveal phase fast-forwarded')
      continue
    }
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
const voterChoicesKeyFor = (code: string) => `${KEYS.round(code)}:voterchoices`

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

// Equivalent participation has the same input to a seeded shuffle, even when
// Redis traverses differently or a replay allocates different opaque IDs.
export function orderedSubmissionKeys(keys: string[], participantOrder: string[]): string[] {
  const available = new Set(keys)
  return participantOrder.flatMap((id) => [id, `${id}:gamble`]).filter((key) => available.has(key))
}

function submissionComplete(
  player: GamePlayer,
  submissions: Record<string, Submission>,
  timerExpired: boolean,
): boolean {
  return (
    !!submissions[player.id] &&
    (!player.hasGambled || !!submissions[`${player.id}:gamble`] || timerExpired)
  )
}

// Picking-phase submission progress for the client counter. Uses the
// EXACT same predicate as checkRoundReady's resolution gate below so the
// UI reaches "N of N" precisely when the round resolves. Rando is
// excluded (it auto-submits and is not part of human progress); skipped
// players drop out so the count can still complete after a timer skip.
// Keep this predicate in sync with checkRoundReady.
export async function submissionProgress(
  code: string,
): Promise<{ submitted: number; expected: number }> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) return { submitted: 0, expected: 0 }
  const [roundRow] = await db
    .select()
    .from(gameRounds)
    .where(eq(gameRounds.sessionId, session.id))
    .orderBy(desc(gameRounds.roundNum))
    .limit(1)
  const czarId = roundRow?.czarPlayerId ?? null
  const [submissions, players, skipped] = await Promise.all([
    state.getSubmissions(code),
    state.getAllPlayers(code),
    state.getSkippedPlayers(code),
  ])
  const skippedSet = new Set(skipped)
  const expectedPlayers = players.filter(
    (p) => p.status === 'active' && p.id !== czarId && !p.isRando && !skippedSet.has(p.id),
  )
  const deadline = await state.getRoundTimerExpiresAt(code)
  const timerExpired = deadline !== null && Date.now() >= deadline
  const submitted = expectedPlayers.filter((p) =>
    submissionComplete(p, submissions, timerExpired),
  ).length
  return { submitted, expected: expectedPlayers.length }
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
  const deadline = await state.getRoundTimerExpiresAt(code)
  const timerExpired = deadline !== null && Date.now() >= deadline
  const ready =
    expected.length > 0 &&
    expected.every((p) => submissionComplete(p, submissions, timerExpired)) &&
    submitted.size >= 2
  if (!ready) return

  // Resolve exactly once per round (guards concurrent last submissions).
  const first = await redis.setnx(resolvingKey(code), '1')
  if (first === 0) return
  await redis.expire(resolvingKey(code), ROOM_TTL_SECONDS)

  // Permute storage keys once; persist so pick/vote/eliminate and the
  // rejoin snapshot all agree on index → submission.
  // Redis hash traversal depends on opaque random player IDs. Start from
  // the stable roster before shuffling so a seeded game is reproducible.
  // Rando has no Czar turn; its submission follows the human roster.
  const participants = [
    ...(await state.getCzarOrder(code)),
    ...players.filter((player) => player.isRando).map((player) => player.id),
  ]
  const order = shuffle(orderedSubmissionKeys(Object.keys(submissions), participants))
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

  await transitionAfterReveal(code, config, czarId, players)
}

// S2-NEW: extracted so the boot path can fast-forward a round whose
// reveal-loop crashed mid-stagger. Idempotent — re-publishing
// elimination_turn / vote_tally is harmless (the client just re-syncs)
// and setPhase is a single HSET.
async function transitionAfterReveal(
  code: string,
  config: GameConfig,
  czarId: string | null,
  players: GamePlayer[],
): Promise<void> {
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

// Report the command outcome at its mutation, before asynchronous reveals
// or round delays. Callers without a receipt callback keep existing behavior.
export async function submitCards(
  code: string,
  playerId: string,
  cardIds: string[],
  onOutcome?: (accepted: boolean) => void,
): Promise<void> {
  const round = await state.getCurrentRound(code)
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  const [roundRow] = session
    ? await db
        .select()
        .from(gameRounds)
        .where(and(eq(gameRounds.sessionId, session.id), eq(gameRounds.roundNum, round)))
    : []
  if (!roundRow || session?.status !== 'active')
    throw new GameCommandError('invalid_state', 'No active round')
  const [black] = await db.select().from(blackCards).where(eq(blackCards.id, roundRow.blackCardId))
  if (!black) throw new GameCommandError('invalid_state', 'No active prompt')
  const allCards = await db.select().from(whiteCards).where(inArray(whiteCards.id, cardIds))
  const fills: Card[] = cardIds.map((id) => {
    const c = allCards.find((x) => x.id === id)
    if (!c) throw new GameCommandError('invalid_state', 'Submit cards from your hand')
    return { id: c.id, text: c.text }
  })
  const submission: Submission = { submissionId: createId(), fills, playerId }

  await state.commitSubmission(
    code,
    playerId,
    submission,
    black.pick,
    roundRow.id,
    round,
    roundRow.czarPlayerId,
  )
  onOutcome?.(true)
  const playedProgress = await submissionProgress(code)
  await state.publishEvent(code, {
    type: 'player_played',
    playerId,
    submitted: playedProgress.submitted,
    expected: playedProgress.expected,
  })
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
  // Rando is excluded from submissionProgress's expected set, but the
  // event still drives the client pip counter — carry the same
  // server-authoritative counts every other player_played does.
  const randoProgress = await submissionProgress(code)
  await state.publishEvent(code, {
    type: 'player_played',
    playerId: rando.id,
    submitted: randoProgress.submitted,
    expected: randoProgress.expected,
  })
  captureServerEvent(await distinctIdForHost(code), 'cab_rule_triggered', {
    roomCode: code,
    rule: 'rando',
  })
}

// Resolution authority belongs here, so every caller uses the persisted
// round Czar and current room policy rather than trusting socket/UI state.
async function authorizeCzarResolution(
  code: string,
  playerId: string,
  action: 'pick' | 'rank',
): Promise<string> {
  const [[session], player, round, phase] = await Promise.all([
    db.select().from(gameSessions).where(eq(gameSessions.code, code)),
    state.getPlayer(code, playerId),
    state.getCurrentRound(code),
    state.getPhase(code),
  ])
  if (!player || player.status !== 'active' || player.role !== 'player' || player.isRando)
    throw new GameCommandError('not_authorized', 'Only an active Czar can resolve the round')
  if (!session || session.status !== 'active')
    throw new GameCommandError('invalid_state', 'The game is not active')

  const [roundRow] = await db
    .select()
    .from(gameRounds)
    .where(and(eq(gameRounds.sessionId, session.id), eq(gameRounds.roundNum, round)))
  if (!roundRow) throw new GameCommandError('invalid_state', 'No current round')
  if (roundRow.czarPlayerId !== playerId)
    throw new GameCommandError('not_authorized', 'Only the current Czar can resolve the round')

  const rules = (session.config as GameConfig).rules
  const allowedMode =
    action === 'rank'
      ? rules.includes('serious_business')
      : !rules.some((rule) => ['godmode', 'survival', 'serious_business'].includes(rule))
  if (!allowedMode || phase !== (action === 'pick' ? 'judging' : 'ranking'))
    throw new GameCommandError('invalid_state', 'This action is not allowed in the current round')
  if (!(await state.ensureRoundIdentity(code, round, roundRow.id, roundRow.czarPlayerId)))
    throw new GameCommandError('invalid_state', 'The round has already advanced')
  return roundRow.id
}

export async function pickWinner(
  code: string,
  czarId: string,
  submissionId: string,
  onOutcome?: (accepted: boolean) => void,
): Promise<void> {
  const roundId = await authorizeCzarResolution(code, czarId, 'pick')
  const submissions = await state.getSubmissions(code)
  const winnerKey = await resolveSubmissionKey(code, submissionId)
  if (!winnerKey || !submissions[winnerKey])
    throw new GameCommandError('invalid_state', 'Command failed')
  const winnerPlayerId = resolvePlayerId(winnerKey)

  // Idempotency gate: clients can re-fire the `pick` WS frame (double-click,
  // network retry) and the WS handler dispatches each frame as a separate
  // async task. Without a single-writer claim, scoring runs twice and
  // endRound interleaves through the non-atomic setHand (del + rpush),
  // producing 20-card hands.
  const claimed = await state.claimRoundOutcome(
    code,
    roundId,
    'judging',
    winnerPlayerId,
    submissionId,
  )
  if (!claimed) {
    onOutcome?.(false)
    return
  }

  const winner = await state.getPlayer(code, winnerPlayerId)
  if (!winner) throw new Error('winner not found')
  const transfer = await settleGambles(code, winnerPlayerId)
  await state.adjustScore(code, winnerPlayerId, 1 + transfer)
  onOutcome?.(true)

  const players = await state.getAllPlayers(code)
  const scores = toPlayerScores(players, czarId)

  await state.publishEvent(code, {
    type: 'round_won',
    winningPlayerId: winnerPlayerId,
    winningSubmissionId: submissionId,
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
  await endRound(code, Object.keys(submissions), roundId)
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
  await touchSessionActivity(code)
}

export async function endRound(
  code: string,
  submitterIds: string[],
  roundId: string,
): Promise<void> {
  if (!(await state.claimRoundCompletion(code, roundId))) return
  const submissions = await state.getSubmissions(code)
  const allFillIds: string[] = []
  for (const s of Object.values(submissions)) for (const f of s.fills) allFillIds.push(f.id)
  await state.discardCards(code, 'white', allFillIds)

  const activePlayers = await state.getAllPlayers(code)
  const activeCount = activePlayers.filter((p) => p.status === 'active').length
  await state.reshuffleWhiteIfLow(code, activeCount * 3)

  // Resolve to unique real playerIds (strip ':gamble' keys)
  const realSubmitterIds = [...new Set(submitterIds.map(resolvePlayerId))]

  for (const pid of realSubmitterIds) await state.refillHand(code, pid, 10)

  // Keep only the public result board for reconnects during the result pause.
  const resultOrder: string[] = JSON.parse((await redis.get(subOrderKey(code))) ?? '[]')
  await redis.hset(
    KEYS.round(code),
    'resolvedSubmissions',
    JSON.stringify(
      resultOrder.map((key, index) => ({
        submissionId: String(index),
        fills: submissions[key]?.fills ?? [],
        ...(submissions[key]?.eliminated ? { eliminated: true } : {}),
      })),
    ),
  )
  await state.clearSubmissions(code)
  await redis.del(
    subOrderKey(code),
    resolvingKey(code),
    revealedKey(code),
    voteTallyKeyFor(code),
    tieKeyFor(code),
    votersKeyFor(code),
    voterChoicesKeyFor(code),
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
      await state.refillHand(code, p.id, 10)
    }
  }

  await state.setPhase(code, 'transition')
  for (const pid of [...realSubmitterIds, ...activated]) await publishHandUpdate(code, pid)

  await state.publishEvent(code, { type: 'round_end', activatedPlayers: activated })

  // Hold on the resolved round (winner highlighted via round_won, hands
  // refilled privately via hand_update) before *anything* that wipes the board —
  // whether that's the next round_started or game_over on the deciding
  // round. Hoisted above the game-over branches so the FINAL round gets
  // the same paced reveal as every other round (it used to skip straight
  // to the end screen). Server-driven so it can't be raced by an
  // immediate round_started / game_over.
  //
  // S2-NEW: the pause used to be a bare `await sleep(...)`, which a
  // process restart in this 4s window dropped on the floor — the round
  // stayed in 'transition' forever. Persist a resume-at cursor before
  // sleeping; the boot path schedules finalizeRoundAfterPause for any
  // session that still has one when this process takes over.
  const resumeAt = Date.now() + roundResultPauseMs()
  await state.setPostResolveResumeAt(code, resumeAt)
  await sleep(roundResultPauseMs())
  await finalizeRoundAfterPause(code)
}

// S2-NEW: the post-pause tail of endRound, extracted so the boot path
// can run it for a session whose endRound was killed mid-sleep. The
// resume-cursor take at the top doubles as an idempotency guard —
// two concurrent callers (the original endRound continuation racing the
// boot-scheduled timer) see one mismatch and the second bails. Use the
// atomic GETDEL-equivalent (takePostResolveResumeAt) so the read+clear
// can't be straddled by a parallel caller — see game-state.ts for why
// the non-atomic version raced under fast E2E pause settings.
async function finalizeRoundAfterPause(code: string): Promise<void> {
  const cursor = await state.takePostResolveResumeAt(code)
  if (cursor === null) return // already finalized by an earlier caller

  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) return
  // The session may have been ended/reset/abandoned out from under us
  // (e.g. host clicked rematch after the round resolved but before the
  // pause finished). Bail rather than start a phantom next round.
  if (session.status !== 'active') return
  const config = session.config as GameConfig
  const refreshed = await state.getAllPlayers(code)

  // Happy Ending: this was the forced "Make a Haiku" final round —
  // end now regardless of score; the Haiku round winner wins the game.
  if (await redis.hget(KEYS.game(code), 'happyEndingFinal')) {
    await redis.hdel(KEYS.game(code), 'happyEndingFinal', 'happyEndingArmed')
    const { winningPlayerId } = await state.getRoundOutcome(code)
    await endGame(code, 'happy_ending', winningPlayerId ?? undefined)
    return
  }

  const winnerPlayer = refreshed.find((p) => p.score >= config.roundsToWin)
  if (winnerPlayer) {
    await endGame(code, winnerPlayer.isRando ? 'rando_won' : 'normal', winnerPlayer.id)
    return
  }

  const nextRound = (await state.getCurrentRound(code)) + 1
  await startRound(code, nextRound)
}

export async function endGame(code: string, mode: GameOverMode, winnerId?: string): Promise<void> {
  await state.updateLiveRoom(code, { status: 'ended' })
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

// #3 (Phase 2): replay the same room after game_over. Reuses the room
// code and keeps players (and their handles); wipes all per-round Redis
// state, zeroes carried players, and either drops back to the lobby
// (`lobby`) or starts a fresh game immediately (`rematch`). The session
// must be `ended` — the endpoint enforces that and host-only.
export async function resetGame(
  code: string,
  mode: ResetMode,
  hostPlayerId?: string,
): Promise<void> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) throw new Error('session not found')

  // Snapshot the roster before mutation so every hand key (incl. Rando's)
  // is cleared regardless of which players are carried.
  const before = await state.getAllPlayers(code)

  // Wipe all per-round Redis state. The room hash and players hash
  // survive; the round hash, decks, discards, czarOrder and every hand
  // are rebuilt fresh by startGame (rematch) or left empty (lobby).
  await state.updateLiveRoom(code, { currentRound: '0', czarIndex: '-1' }, hostPlayerId, [
    KEYS.round(code),
    KEYS.deckBlack(code),
    KEYS.deckWhite(code),
    KEYS.discardWhite(code),
    KEYS.discardBlack(code),
    KEYS.czarOrder(code),
    ...before.map((p) => KEYS.hand(code, p.id)),
  ])
  await redis.hdel(KEYS.game(code), 'czarStartOffset', 'happyEndingArmed', 'happyEndingFinal')

  // Drop the prior game's round history. buildSnapshot derives the live
  // round from max(gameRounds.roundNum), and startRound inserts with
  // onConflictDoNothing on unique(session_id, round_num) — leaving the old
  // rows would pin the snapshot to the final round and silently no-op the
  // new round 1. A reset is a fresh game, so the history goes.
  await db.delete(gameRounds).where(eq(gameRounds.sessionId, session.id))

  // Drop the prior Rando row(s) — startGame re-creates Rando if the rule
  // is still configured (partial-unique on is_rando per session).
  await db
    .delete(gamePlayers)
    .where(and(eq(gamePlayers.sessionId, session.id), eq(gamePlayers.isRando, true)))

  for (const p of before) {
    // Not carried: Rando (re-created by startGame) and terminally
    // dropped players (no live socket / cleared session — they re-join
    // by code into the new lobby). Remove from the live roster.
    if (p.isRando || p.status === 'dropped') {
      await redis.hdel(KEYS.players(code), p.id)
      continue
    }
    // Carried: zero the score and clear per-game flags. A `grace` player
    // is treated as present again; clear any pending grace key so a
    // stale grace-expiry drop can't fire mid-rematch.
    await state.clearGrace(code, p.id)
    await state.updatePlayer(code, p.id, {
      score: 0,
      status: 'active',
      discardsUsed: 0,
      hasGambled: false,
    })
    await db
      .update(gamePlayers)
      .set({ score: 0, status: 'active', discardsUsed: 0 })
      .where(eq(gamePlayers.id, p.id))
  }

  // The game is replayable from a clean slate — clear the ended outcome.
  await db
    .update(gameSessions)
    .set({
      status: mode === 'lobby' ? 'lobby' : 'active',
      endedAt: null,
      endMode: null,
      winnerPlayerId: null,
      lastActivityAt: new Date(),
    })
    .where(eq(gameSessions.id, session.id))

  if (mode === 'lobby') {
    await state.updateLiveRoom(code, { status: 'lobby' }, hostPlayerId)
    const players = await state.getAllPlayers(code)
    await state.publishEvent(code, {
      type: 'lobby_snapshot',
      players,
      config: session.config as GameConfig,
      gameStatus: 'lobby',
    })
    await state.publishEvent(code, { type: 'game_reset', mode })
    engineLogger.info({ code }, 'game reset to lobby')
    return
  }

  // Rematch: tell every end-screen client to route through the lobby
  // hub first, then start a brand-new game. startGame rebuilds decks /
  // czarOrder / hands and flips the room status to active; the late
  // reconnect is hydrated by rejoin → state_snapshot (existing path).
  await state.publishEvent(code, { type: 'game_reset', mode })
  await startGame(code, hostPlayerId)
  await state.publishEvent(code, { type: 'game_started', firstRound: 1 })
  await startRound(code, 1)
  engineLogger.info({ code }, 'game reset — rematch started')
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
    await state.appendToHand(
      code,
      pid,
      sub.fills.map((f) => f.id),
    )
    await publishHandUpdate(code, pid)
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
  await state.setPhase(code, 'transition')
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
    voterChoicesKeyFor(code),
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
  await state.updateLiveRoom(code, { hostId: next.id })

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
  await state.updateLiveRoom(code, { status: 'paused' })
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
  await state.updateLiveRoom(code, { status: 'active' })
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
  connection?: string,
): Promise<void> {
  if (!(await state.claimPlayerDrop(code, playerId, connection))) return
  await touchSessionActivity(code)
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
    await state.adjustScore(code, p.id, -1)
    transfer += 1
  }
  return transfer
}

// Recovery and runtime commands share missing-only identity hydration so a
// room already active during deployment can resolve without resetting claims.
async function currentRoundIdentity(code: string): Promise<string | null> {
  const persisted = await redis.hget(KEYS.round(code), 'roundId')
  if (persisted) return persisted
  const round = await state.getCurrentRound(code)
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session || session.status !== 'active') return null
  const [row] = await db
    .select()
    .from(gameRounds)
    .where(and(eq(gameRounds.sessionId, session.id), eq(gameRounds.roundNum, round)))
  if (!row || !(await state.ensureRoundIdentity(code, round, row.id, row.czarPlayerId))) return null
  return row.id
}

// Redis tally iteration has no stable order. Canonical public submission IDs
// ensure a seeded draw maps to the same candidate for equivalent ballots.
export function chooseVoteWinner(leaders: string[]): string {
  const candidates = [...leaders].sort((a, b) => Number(a) - Number(b))
  return candidates.length === 1 ? candidates[0]! : pick(candidates)
}

export async function castVote(
  code: string,
  voterId: string,
  submissionId: string,
  onOutcome?: (accepted: boolean) => void,
): Promise<void> {
  const roundId = await currentRoundIdentity(code)
  if (!roundId) throw new GameCommandError('invalid_state', 'No active round')
  const epoch = (await redis.hget(KEYS.round(code), 'voteEpoch')) ?? '0'
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (
    !session ||
    session.status !== 'active' ||
    !(session.config as GameConfig).rules.includes('godmode')
  ) {
    throw new GameCommandError('invalid_state', 'Voting requires an active God Is Dead round')
  }
  if ((await state.getPhase(code)) !== 'waiting')
    throw new GameCommandError('invalid_state', 'The round is not accepting votes')
  const voter = await state.getPlayer(code, voterId)
  if (!voter || voter.status !== 'active' || voter.role !== 'player' || voter.isRando)
    throw new GameCommandError('not_authorized', 'Only active players can vote')
  const votedKey = await resolveSubmissionKey(code, submissionId)
  if (!votedKey) {
    throw new GameCommandError('invalid_state', 'Choose a current submission')
  }
  // Canonical public IDs make "0" and "00" the same ballot target.
  const order = await getSubOrder(code)
  const canonicalId = publicIdForKey(order, votedKey)
  const result = await state.commitVote(code, roundId, epoch, voterId, canonicalId, votedKey)
  if (!result) throw new GameCommandError('invalid_state', 'This vote is no longer available')
  onOutcome?.(true)
  const { tally, leaders, revote } = result
  await state.publishEvent(code, { type: 'vote_tally', votes: tally })
  if (revote) {
    await state.publishEvent(code, { type: 'vote_tally', votes: {} })
    return
  }
  if (!leaders) return
  const submissions = await state.getSubmissions(code)
  const winnerSubmissionId = chooseVoteWinner(leaders)
  const winnerKey = await resolveSubmissionKey(code, winnerSubmissionId)
  if (!winnerKey) return
  const winnerPlayerId = resolvePlayerId(winnerKey)

  const winner = await state.getPlayer(code, winnerPlayerId)
  if (!winner) return
  if (
    !(await state.claimRoundOutcome(code, roundId, 'waiting', winnerPlayerId, winnerSubmissionId))
  )
    return
  const transfer = await settleGambles(code, winnerPlayerId)
  await state.adjustScore(code, winnerPlayerId, 1 + transfer)

  const allPlayers = await state.getAllPlayers(code)
  const scores = toPlayerScores(allPlayers, null)

  // Winner and terminal phase were persisted by the common outcome claim.
  await state.publishEvent(code, {
    type: 'round_won',
    winningPlayerId: winnerPlayerId,
    winningSubmissionId: winnerSubmissionId,
    winnerId: winnerPlayerId,
    submissionId: winnerSubmissionId,
    scores,
  })
  captureServerEvent(await distinctIdForHost(code), 'cab_round_voted', {
    roomCode: code,
    winnerId: winnerPlayerId,
    voteSpread: tally,
  })
  await redis.del(voteTallyKeyFor(code))
  await persistRoundOutcome(code, {
    winnerPlayerId,
    winningFills: submissions[winnerKey]?.fills ?? [],
    voteTally: tally,
  })
  await endRound(code, Object.keys(submissions), roundId)
}

export async function eliminateSubmission(
  code: string,
  byPlayerId: string,
  submissionId: string,
): Promise<void> {
  const roundId = await currentRoundIdentity(code)
  if (!roundId) throw new GameCommandError('invalid_state', 'No active round')
  const submissions = await state.getSubmissions(code)
  const order = await getSubOrder(code)
  const pid = await resolveSubmissionKey(code, submissionId)
  if (!pid || !submissions[pid])
    throw new GameCommandError('invalid_state', 'Choose a current submission')
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (
    !session ||
    session.status !== 'active' ||
    !(session.config as GameConfig).rules.includes('survival')
  )
    throw new GameCommandError('invalid_state', 'Elimination requires an active Survival round')
  if ((await state.getPhase(code)) !== 'eliminating')
    throw new GameCommandError('invalid_state', 'The round is not accepting eliminations')
  const turn = await state.getEliminationTurn(code)
  if (!turn) throw new GameCommandError('invalid_state', 'No current elimination turn')
  const [roundRow] = await db
    .select()
    .from(gameRounds)
    .where(and(eq(gameRounds.sessionId, session.id), eq(gameRounds.id, roundId)))
  if (!roundRow) throw new GameCommandError('invalid_state', 'No current round')
  const czarId = roundRow.czarPlayerId
  const activePlayers = (await state.getAllPlayers(code)).filter(
    (p) => p.status === 'active' && p.role === 'player' && !p.isRando && p.id !== czarId,
  )
  const currentIdx = activePlayers.findIndex((p) => p.id === byPlayerId)
  if (currentIdx < 0 || turn !== byPlayerId)
    throw new GameCommandError('not_authorized', 'Only the current active eliminator can act')
  const nextPlayer = activePlayers[(currentIdx + 1) % activePlayers.length]
  const winnerKey = await state.commitElimination(
    code,
    roundId,
    byPlayerId,
    pid,
    nextPlayer?.id ?? '',
  )
  if (winnerKey === null)
    throw new GameCommandError('invalid_state', 'This elimination is no longer available')
  await state.publishEvent(code, { type: 'card_eliminated', submissionId, byPlayerId })
  if (winnerKey) {
    const winnerPlayerId = resolvePlayerId(winnerKey)
    const winner = await state.getPlayer(code, winnerPlayerId)
    if (!winner) return
    if (
      !(await state.claimRoundOutcome(
        code,
        roundId,
        'eliminating',
        winnerPlayerId,
        String(order.indexOf(winnerKey)),
      ))
    )
      return
    const transfer = await settleGambles(code, winnerPlayerId)
    await state.adjustScore(code, winnerPlayerId, 1 + transfer)

    const allPlayers = await state.getAllPlayers(code)
    const scores = toPlayerScores(allPlayers, null)
    // Winner and terminal phase were persisted by the common outcome claim.
    await state.publishEvent(code, {
      type: 'round_won',
      winningPlayerId: winnerPlayerId,
      winningSubmissionId: publicIdForKey(order, winnerKey),
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
    await endRound(code, Object.keys(submissions), roundId)
  } else if (nextPlayer) {
    await state.publishEvent(code, { type: 'elimination_turn', playerId: nextPlayer.id })
  }
}

export async function applyRanking(code: string, czarId: string, ranking: string[]): Promise<void> {
  const roundId = await authorizeCzarResolution(code, czarId, 'rank')
  const submissions = await state.getSubmissions(code)
  // Validate the entire command before crediting any submission. A stale
  // target in a later podium slot must not leave a partially scored round.
  const keys = await Promise.all(ranking.map((sid) => resolveSubmissionKey(code, sid)))
  if (
    ranking.length !== Math.min(3, Object.keys(submissions).length) ||
    keys.length === 0 ||
    keys.some((key) => !key || !submissions[key]) ||
    new Set(keys).size !== keys.length
  )
    throw new GameCommandError('invalid_state', 'Ranking must use distinct current submissions')
  if (
    !(await state.claimRoundOutcome(
      code,
      roundId,
      'ranking',
      resolvePlayerId(keys[0]!),
      ranking[0]!,
    ))
  )
    return
  const points = [3, 2, 1] as const
  const scoresDelta: Record<string, number> = {}
  const rankedSubmissions: Submission[] = []
  // Serious Business has no single Czar pick — winner_player_id is the
  // top-ranked submission's player (SPEC.md § Serious Business).
  let topWinnerId: string | null = null
  let topFills: Card[] = []

  for (let i = 0; i < ranking.length && i < 3; i++) {
    const sid = ranking[i]!
    const key = keys[i]!
    const submission = submissions[key]!
    const pid = resolvePlayerId(key)
    const pts = points[i] ?? 1
    scoresDelta[pid] = pts
    const player = await state.getPlayer(code, pid)
    if (player) await state.adjustScore(code, pid, pts)
    if (rankedSubmissions.length === 0) {
      topWinnerId = pid
      topFills = submission.fills
    }
    rankedSubmissions.push({ ...submission, submissionId: sid, rank: (i + 1) as 1 | 2 | 3 })
  }

  await state.setRoundRanking(code, rankedSubmissions)
  await state.publishEvent(code, {
    type: 'round_ranked',
    winningPlayerId: topWinnerId!,
    winningSubmissionId: ranking[0]!,
    ranking: rankedSubmissions,
    scoresDelta,
  })
  captureServerEvent(await distinctIdForHost(code), 'cab_round_ranked', {
    roomCode: code,
    top3: rankedSubmissions.map((s) => s.playerId).filter(Boolean),
  })
  await persistRoundOutcome(code, {
    winnerPlayerId: topWinnerId,
    winningFills: topFills,
    ranking: rankedSubmissions,
  })
  await endRound(code, Object.keys(submissions), roundId)
}

// Push the player's current hand to its owner as a private `hand_update`.
// Used by mutations that change the hand outside the round-start refill
// flow (redraw, confess_discard, gamble's extra draw) — the snapshot in
// Redis is authoritative but the client only learns of changes through
// these targeted broadcasts. The WS layer routes hand_update privately
// to the matching peer, so this is safe to call from any code path.
// Push a refreshed scoreboard to every client. Used by mutations that
// change a score outside the round_won path (redraw burns a point;
// settleGambles already pipes through round_won so no need there). Reads
// the current czar from the latest gameRounds row so the JUDGE chip
// stays correct between rounds — `null` in transition/lobby is fine.
async function broadcastScores(code: string): Promise<void> {
  const [session] = await db
    .select({ id: gameSessions.id })
    .from(gameSessions)
    .where(eq(gameSessions.code, code))
  if (!session) return
  const [latestRound] = await db
    .select({ czarPlayerId: gameRounds.czarPlayerId })
    .from(gameRounds)
    .where(eq(gameRounds.sessionId, session.id))
    .orderBy(desc(gameRounds.roundNum))
    .limit(1)
  const players = await state.getAllPlayers(code)
  const scores = toPlayerScores(players, latestRound?.czarPlayerId ?? null)
  await state.publishEvent(code, { type: 'scores_update', scores })
}

async function publishHandUpdate(code: string, playerId: string): Promise<void> {
  while (true) {
    const [ids, player] = await Promise.all([
      state.getHand(code, playerId),
      state.getPlayer(code, playerId),
    ])
    if (!player) return
    const rows = ids.length
      ? await db.select().from(whiteCards).where(inArray(whiteCards.id, ids))
      : []
    const hand: Card[] = ids.map((id) => {
      const c = rows.find((x) => x.id === id)
      return c ? { id: c.id, text: c.text } : { id, text: '' }
    })
    if (
      await state.publishHandUpdateIfCurrent(code, playerId, ids, player.discardsUsed, {
        type: 'hand_update',
        playerId,
        hand,
        discardsUsed: player.discardsUsed,
      })
    )
      return
  }
}

export async function gamble(code: string, playerId: string): Promise<void> {
  const round = await state.getCurrentRound(code)
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session || session.status !== 'active')
    throw new GameCommandError('invalid_state', 'No active round')
  const rules = (session.config as GameConfig).rules
  if (rules.some((rule) => ['godmode', 'survival', 'serious_business'].includes(rule)))
    throw new GameCommandError('invalid_state', 'Gambling requires normal mode')
  const [roundRow] = await db
    .select()
    .from(gameRounds)
    .where(and(eq(gameRounds.sessionId, session.id), eq(gameRounds.roundNum, round)))
  if (!roundRow) throw new GameCommandError('invalid_state', 'No active round')
  const [black] = await db.select().from(blackCards).where(eq(blackCards.id, roundRow.blackCardId))
  if (!black) throw new GameCommandError('invalid_state', 'No active prompt')

  // The point remains reserved until settlement so voided rounds keep it.
  // Drawing and appending here atomically also protects a simultaneous play.
  await state.claimGamble(code, playerId, roundRow.id, round, roundRow.czarPlayerId, black.pick)
  await publishHandUpdate(code, playerId)
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
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session || !(session.config as GameConfig).rules.includes('rebooting'))
    throw new GameCommandError('invalid_state', 'Rebooting is not enabled')
  const phase = await state.getPhase(code)
  if (session.status !== 'active' || (phase !== 'picking' && phase !== 'transition'))
    throw new GameCommandError('invalid_state', 'Redraw is not allowed in this phase')
  await state.commitRedraw(code, playerId)
  // The hand_update lets the redrawing player render the fresh ten;
  // scores_update propagates the -1 deduction to every scoreboard so
  // the Redraw button's own enable check (score ≥ 1) self-throttles.
  await publishHandUpdate(code, playerId)
  await broadcastScores(code)
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
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (
    !session ||
    session.status !== 'active' ||
    !(session.config as GameConfig).rules.includes('never_have_i_ever')
  )
    throw new GameCommandError('invalid_state', 'Confession discards are not enabled')
  await state.commitConfession(code, playerId, cardId)
  await publishHandUpdate(code, playerId)
  captureServerEvent(await distinctIdFor(code, playerId), 'cab_rule_triggered', {
    roomCode: code,
    playerId,
    rule: 'never_have_i_ever',
  })
}

export async function applyPackingHeat(code: string, playerIds: string[]): Promise<void> {
  for (const pid of playerIds) {
    await state.drawToHand(code, pid, 1)
    await publishHandUpdate(code, pid)
  }
}

// Happy Ending: host ends the game early. Queues the synthetic "Make a
// Haiku" black card as the next prompt and arms the forced final round.
// The current round finishes normally; the next round is the Haiku round,
// after which endRound ends the game (current leader wins) regardless of
// score.
export async function triggerHappyEnding(code: string, playerId: string): Promise<void> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) {
    engineLogger.warn({ code, playerId }, 'happy_ending: no session')
    return
  }
  if (session.status !== 'active') {
    engineLogger.warn(
      { code, playerId, status: session.status },
      'happy_ending: session not active',
    )
    return
  }
  if (session.hostPlayerId !== playerId) {
    engineLogger.warn(
      { code, playerId, hostId: session.hostPlayerId },
      'happy_ending: caller is not host',
    )
    return
  }
  const config = session.config as GameConfig
  if (!config.rules.includes('happy_ending')) {
    engineLogger.warn({ code, playerId, rules: config.rules }, 'happy_ending: rule not configured')
    return
  }
  // Idempotent: ignore repeat triggers once armed.
  if (await redis.hget(KEYS.game(code), 'happyEndingArmed')) {
    engineLogger.info({ code, playerId }, 'happy_ending: already armed (idempotent)')
    return
  }

  // Just arm the flag — startRound resolves the Haiku card directly when
  // it sees the flag, so we don't race the deck LPUSH against the next
  // LPOP (a slow trigger could otherwise land between rounds and pin the
  // Haiku two rounds out).
  await state.updateLiveRoom(code, { happyEndingArmed: '1' }, playerId)
  engineLogger.info({ code, playerId }, 'happy ending armed')
  captureServerEvent(await distinctIdFor(code, playerId), 'cab_rule_triggered', {
    roomCode: code,
    playerId,
    rule: 'happy_ending',
  })
}
