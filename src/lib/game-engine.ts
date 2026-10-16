import { db } from '~/db'
import {
  blackCards,
  whiteCards,
  gameSessions,
  gameMatches,
  gamePlayers,
  gameRounds,
  packs,
} from '~/db/schema'
import { inArray, eq, desc, and } from 'drizzle-orm'
import { randomInt, shuffle, pick } from './rng'
import { redis, KEYS, ROOM_TTL_SECONDS } from './redis'
import * as state from './game-state'
import { ROOM_LIFETIME_LUA, EXPIRE_ROOM_KEY_LUA, expireRoomStateKeys } from './room-lifetime'
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
import { decideDeckExhaustion } from './deck-exhaustion'
import { decideNormalRound } from './normal-round'
import { recoveryRetryMs, type RecoveryProgress } from './recovery-status'

type RoundTimer = {
  identity: string
  timer?: ReturnType<typeof setTimeout>
  running?: Promise<void>
  attempts: number
  error?: unknown
}
// Source WS and bundled SSR engines share ownership of process-local timers.
const timerRuntime = globalThis as typeof globalThis & {
  __cabRoundTimers?: Map<string, RoundTimer>
}
const roundTimers = (timerRuntime.__cabRoundTimers ??= new Map<string, RoundTimer>())

async function armRoundTimer(
  code: string,
  round: number,
  czarId: string | null,
  deadline: number,
  roundId: string,
): Promise<void> {
  const identity = `${roundId}:${deadline}`
  const existing = roundTimers.get(code)
  if (existing?.identity === identity) {
    if (existing.running) return existing.running
    if (existing.error) throw existing.error
    return
  }
  if (existing?.timer) clearTimeout(existing.timer)
  const owner: RoundTimer = { identity, attempts: 0 }
  roundTimers.set(code, owner)
  const run = (): Promise<void> => {
    if (roundTimers.get(code) !== owner) return Promise.resolve()
    if (owner.running) return owner.running
    owner.error = undefined
    owner.running = expireRoundTimer(code, round, czarId, deadline)
      .then(() => {
        if (roundTimers.get(code) === owner) roundTimers.delete(code)
      })
      .catch((err) => {
        if (roundTimers.get(code) === owner) {
          owner.error = err
          owner.timer = setTimeout(onTimeout, recoveryRetryMs(++owner.attempts))
          owner.timer.unref()
        }
        throw err
      })
      .finally(() => {
        owner.running = undefined
      })
    return owner.running
  }
  const onTimeout = () =>
    run().catch((err) => engineLogger.warn({ err, code, round }, 'round timer retry pending'))
  const delay = deadline - Date.now()
  if (delay <= 0) await run()
  else {
    owner.timer = setTimeout(onTimeout, delay)
    owner.timer.unref()
  }
}

export function chooseFirstCzar(activePlayerCount: number): number {
  return randomInt(0, activePlayerCount)
}

// Record SQL sweeper activity without renewing the Redis idle deadline.
// Completion/recovery may retry this work; only accepted participant commands
// renew the durable room state at their atomic Redis commit.
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
  await startMatch(code, hostPlayerId, 'lobby')
}

async function startMatch(
  code: string,
  hostPlayerId: string | undefined,
  expectedStatus: 'lobby' | 'active',
): Promise<void> {
  let attemptedMatchId: string | undefined
  try {
    await db.transaction(async (tx) => {
      // Admission and configuration edits use this same lock. Keep it through
      // setup so failed initialization cannot commit an unplayable active room.
      const [room] = await tx
        .select()
        .from(gameSessions)
        .where(eq(gameSessions.code, code))
        .for('update')
      if (!room) throw new GameCommandError('room_not_found', 'Room not found')
      if (hostPlayerId && room.hostPlayerId !== hostPlayerId)
        throw new GameCommandError('host_only', 'Only the host can start')
      if (room.status !== expectedStatus || room.currentMatchId)
        throw new GameCommandError('invalid_state', 'Game already started')

      // Authentication can recover ownership before taking the lock. Only
      // validate existing live membership here; recovery would lock this row.
      await state.updateLiveRoom(code, {}, hostPlayerId)
      const activePlayers = (await state.getLivePlayers(code))
        .filter(
          (player) => player.role === 'player' && player.status === 'active' && !player.isRando,
        )
        .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
      if (expectedStatus === 'lobby' && activePlayers.length < 3)
        throw new GameCommandError('invalid_state', 'Need at least 3 players')

      const config = room.config as GameConfig
      // A prior failed attempt may have lost its cleanup connection. There is
      // no current match under this lock, so its partial live setup is obsolete.
      await clearFailedMatchSetup(code, config, expectedStatus)
      const [match] = await tx
        .insert(gameMatches)
        .values({ sessionId: room.id, config })
        .returning()
      attemptedMatchId = match!.id
      await buildDecks(code, config.packs)

      if (config.rules.includes('rando')) {
        // Use the lock-owning connection: a separate INSERT's session FK
        // would wait for the room row held by this transaction.
        const [rando] = await tx
          .insert(gamePlayers)
          .values({
            sessionId: room.id,
            username: 'Rando Cardrissian',
            role: 'player',
            status: 'active',
            isRando: true,
          })
          .returning()
        const randoPlayer: GamePlayer = {
          id: rando!.id,
          username: rando!.username,
          role: 'player',
          status: 'active',
          score: 0,
          isHost: false,
          isRando: true,
          discardsUsed: 0,
          joinedAt: rando!.joinedAt.toISOString(),
        }
        await state.addPlayer(code, randoPlayer)
        activePlayers.push(randoPlayer)
      }

      // The stable rotation follows human join order; Rando receives a hand
      // but cannot be Czar. No round or event is published before commit.
      const czarOrderIds = activePlayers.filter((p) => !p.isRando).map((p) => p.id)
      await state.setCzarOrder(code, czarOrderIds)
      await dealStartingHands(
        code,
        activePlayers.map((p) => p.id),
      )
      const firstCzarIdx = chooseFirstCzar(czarOrderIds.length)
      await state.updateLiveRoom(
        code,
        {
          status: 'active',
          config: JSON.stringify(config),
          czarStartOffset: String(firstCzarIdx),
        },
        hostPlayerId,
        [],
        undefined,
        true,
      )
      await tx
        .update(gameSessions)
        .set({ status: 'active', currentMatchId: match!.id, lastActivityAt: new Date() })
        .where(eq(gameSessions.id, room.id))
      engineLogger.info({ code, firstCzarIdx, players: activePlayers.length }, 'game initialized')
    })
  } catch (error) {
    if (attemptedMatchId) {
      try {
        const committed = await db.transaction(async (tx) => {
          const [room] = await tx
            .select()
            .from(gameSessions)
            .where(eq(gameSessions.code, code))
            .for('update')
          // COMMIT may have succeeded despite a lost acknowledgement. Its
          // pointer is installed only after all setup completed successfully.
          if (room?.currentMatchId === attemptedMatchId) return true
          // Never erase a newer successful attempt while compensating ours.
          if (room && !room.currentMatchId && room.status === expectedStatus)
            await clearFailedMatchSetup(code, room.config as GameConfig, expectedStatus)
          return false
        })
        if (committed) return
      } catch (cleanupError) {
        // A later start cleans this partial setup under the same room lock.
        engineLogger.warn({ err: cleanupError, code }, 'failed start cleanup deferred')
      }
    }
    throw error
  }
}

async function clearFailedMatchSetup(
  code: string,
  config: GameConfig,
  expectedStatus: 'lobby' | 'active',
): Promise<void> {
  const players = await state.getAllPlayers(code)
  await state.updateLiveRoom(
    code,
    {
      status: expectedStatus === 'lobby' ? 'lobby' : 'resetting',
      config: JSON.stringify(config),
      currentRound: '0',
      czarIndex: '-1',
    },
    undefined,
    [
      KEYS.round(code),
      KEYS.deckBlack(code),
      KEYS.deckWhite(code),
      KEYS.discardWhite(code),
      KEYS.discardBlack(code),
      KEYS.czarOrder(code),
      ...players.map((player) => KEYS.hand(code, player.id)),
    ],
  )
  const randoIds = players.filter((player) => player.isRando).map((player) => player.id)
  if (randoIds.length) await redis.hdel(KEYS.players(code), ...randoIds)
  await redis.hdel(KEYS.game(code), 'czarStartOffset')
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
  const reservedPlan = await redis.hget(KEYS.game(code), 'roundStartCard')
  if (reservedPlan) {
    const plan = JSON.parse(reservedPlan) as { round: number; card: string }
    if (plan.round === round)
      [black] = await db.select().from(blackCards).where(eq(blackCards.id, plan.card))
  }
  const armed = await redis.hget(KEYS.game(code), 'happyEndingArmed')
  if (!black && armed) {
    const [haiku] = await db
      .select()
      .from(blackCards)
      .innerJoin(packs, eq(blackCards.packId, packs.id))
      .where(eq(packs.slug, 'haiku-final'))
      .limit(1)
    if (haiku) {
      black = haiku.black_cards
      await redis
        .multi()
        .hset(
          KEYS.game(code),
          'happyEndingFinal',
          '1',
          'roundStartCard',
          JSON.stringify({ round, card: black.id }),
        )
        .hdel(KEYS.game(code), 'happyEndingArmed')
        .exec()
    } else {
      engineLogger.error({ code }, 'happy_ending: armed but Haiku card not seeded; falling back')
    }
  }

  if (!black) {
    const reserved = await redis.eval(
      `
      local plan = redis.call('HGET', KEYS[1], 'roundStartCard')
      if plan then
        local p = cjson.decode(plan)
        if p.round == tonumber(ARGV[1]) then return p.card end
      end
      local card = redis.call('LPOP', KEYS[2])
      if card then redis.call('HSET', KEYS[1], 'roundStartCard', cjson.encode({round=tonumber(ARGV[1]), card=card})) end
      return card
    `,
      2,
      KEYS.game(code),
      KEYS.deckBlack(code),
      round,
    )
    const blackIds = reserved ? [String(reserved)] : []
    if (blackIds.length === 0) {
      const outcome = decideDeckExhaustion(
        await state.getAllPlayers(code),
        await state.getCzarOrder(code),
      )
      if (outcome.status === 'paused') await pauseGame(code)
      else {
        if (await redis.hget(KEYS.game(code), 'completionIntent'))
          await redis.hset(
            KEYS.game(code),
            'completionGameEnd',
            JSON.stringify({ mode: 'deck_exhausted', winnerId: outcome.winnerId }),
          )
        await endGame(code, 'deck_exhausted', outcome.winnerId)
      }
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

  const [inserted] = await db
    .insert(gameRounds)
    .values({
      sessionId: session.id,
      matchId: session.currentMatchId!,
      roundNum: round,
      blackCardId: black.id,
      czarPlayerId: czarId ?? undefined,
    })
    .onConflictDoNothing()
    .returning({ id: gameRounds.id })
  const [existing] = inserted
    ? []
    : await db
        .select()
        .from(gameRounds)
        .where(
          and(
            and(
              eq(gameRounds.sessionId, session.id),
              eq(gameRounds.matchId, session.currentMatchId!),
            ),
            eq(gameRounds.roundNum, round),
          ),
        )
  const roundRow = inserted ?? existing
  if (!roundRow) throw new Error('round missing')
  if (existing && existing.blackCardId !== black.id) throw new Error('round already exists')
  if (existing) czarId = existing.czarPlayerId
  await redis.eval(
    `${ROOM_LIFETIME_LUA}
    if not redis.call('HGET', KEYS[2], 'status') then return end
    if redis.call('HGET', KEYS[1], 'roundId') == ARGV[1] then return end
    redis.call('HDEL', KEYS[1], 'winnerId', 'winningPlayerId', 'winningSubmissionId', 'resolvedSubmissions', 'resolvedRecipients', 'resolvedVoteTally', 'ranking', 'eliminationTurnPlayerId', 'outcomeClaim', 'completionClaim', 'voteEpoch', 'voteClosed', 'voteCandidateIds', 'postResolveResumeAt', 'roundTimerExpiresAt')
    redis.call('HSET', KEYS[1], 'roundId', ARGV[1], 'matchId', ARGV[5], 'czarId', ARGV[2], 'phase', 'picking')
    redis.call('HSET', KEYS[2], 'currentRound', ARGV[3], 'matchId', ARGV[5])
    redis.call('DEL', KEYS[3])
    expireRoomKey(KEYS[1])
  `,
    3,
    KEYS.round(code),
    KEYS.game(code),
    `${KEYS.round(code)}:skipped`,
    roundRow.id,
    czarId ?? '',
    round,
    ROOM_TTL_SECONDS,
    session.currentMatchId!,
  )
  await touchSessionActivity(code)

  // Arm the round timer before announcing the round so round_started can
  // carry the authoritative expiry for the client's display-only countdown.
  let roundTimerExpiresAt: number | null = null
  if (config.timer !== 'Off') {
    const ms = TIMER_MS[config.timer]
    roundTimerExpiresAt = (await state.getRoundTimerExpiresAt(code)) ?? Date.now() + ms
    await state.setRoundTimerExpiresAt(code, roundTimerExpiresAt)
    await armRoundTimer(code, round, czarId, roundTimerExpiresAt, roundRow.id)
  } else {
    await redis.hdel(KEYS.round(code), 'roundTimerExpiresAt')
  }

  const startProgress = await submissionProgress(code)
  await redis.eval(
    `
    if redis.call('HGET', KEYS[1], 'roundStartPublished') == ARGV[1] then return end
    redis.call('PUBLISH', KEYS[2], ARGV[2])
    redis.call('HSET', KEYS[1], 'roundStartPublished', ARGV[1])
  `,
    2,
    KEYS.game(code),
    KEYS.channel(code),
    roundRow.id,
    JSON.stringify({
      type: 'round_started',
      round,
      prompt: { id: black.id, text: black.text, pick: black.pick },
      czarId,
      submitted: startProgress.submitted,
      expected: startProgress.expected,
      roundTimerExpiresAt,
    }),
  )
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
      .filter((p) => p.status === 'active' && p.role === 'player' && !p.isRando && p.id !== czarId)
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
  armedAt: number,
): Promise<void> {
  // Guard 1: round already advanced past this timer.
  const currentRound = await state.getCurrentRound(code)
  if (currentRound !== round) return

  // Both freshly armed and restored callbacks belong to the deadline they
  // scheduled. Resetting a match can reuse the round number, but replaces
  // this persisted deadline; recheck it when the callback executes.
  const persisted = await state.getRoundTimerExpiresAt(code)
  if (persisted !== armedAt) return

  const [submissions, players] = await Promise.all([
    state.getSubmissions(code),
    state.getAllPlayers(code),
  ])

  const activePlayers = players.filter(
    (p) => p.status === 'active' && p.role === 'player' && !p.isRando,
  )
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
          .where(
            and(
              eq(gameRounds.sessionId, session.id),
              eq(gameRounds.matchId, session.currentMatchId!),
            ),
          )
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
export async function restoreRoundTimers(
  onProgress?: (progress: RecoveryProgress) => void,
): Promise<void> {
  const sessions = await db
    .select({
      id: gameSessions.id,
      currentMatchId: gameSessions.currentMatchId,
      code: gameSessions.code,
      config: gameSessions.config,
      status: gameSessions.status,
    })
    .from(gameSessions)
    .where(inArray(gameSessions.status, ['active', 'ended']))
    .orderBy(gameSessions.code)
  const failures: unknown[] = []
  let recovered = 0
  const report = () =>
    onProgress?.({ total: sessions.length, recovered, pending: sessions.length - recovered })
  report()
  for (const s of sessions) {
    let failed = false
    try {
      const { code } = s
      const currentRound = await state.getCurrentRound(code)
      const [currentRow] = await db
        .select()
        .from(gameRounds)
        .where(
          and(
            and(eq(gameRounds.sessionId, s.id), eq(gameRounds.matchId, s.currentMatchId!)),
            eq(gameRounds.roundNum, currentRound),
          ),
        )
      if (
        !currentRow ||
        !(await state.ensureRoundIdentity(
          code,
          currentRound,
          currentRow.id,
          currentRow.czarPlayerId,
        ))
      )
        continue
      if (await redis.hget(KEYS.game(code), 'completionIntent')) {
        await continueRoundCompletion(code)
        continue
      }
      if (s.status !== 'active') continue
      const phase = await state.getPhase(code)

      if (phase === 'waiting' && (await redis.hget(KEYS.round(code), 'voteClosed'))) {
        const tally = Object.fromEntries(
          Object.entries(await redis.hgetall(voteTallyKeyFor(code))).map(([id, n]) => [
            id,
            Number(n),
          ]),
        )
        const max = Math.max(...Object.values(tally))
        const leaders = Object.keys(tally).filter((id) => tally[id] === max)
        if (leaders.length) {
          const sid = chooseVoteWinner(leaders)
          const key = await resolveSubmissionKey(code, sid)
          if (key) {
            await recordSingleWinnerIntent(
              code,
              currentRow.id,
              key,
              await state.getSubmissions(code),
              sid,
              null,
              tally,
            )
            await continueRoundCompletion(code)
          }
        }
        continue
      }
      if (phase === 'eliminating') {
        const submissions = await state.getSubmissions(code)
        const remaining = Object.keys(submissions).filter((key) => !submissions[key]?.eliminated)
        if (remaining.length === 1) {
          const key = remaining[0]!
          await recordSingleWinnerIntent(
            code,
            currentRow.id,
            key,
            submissions,
            publicIdForKey(await getSubOrder(code), key),
            currentRow.czarPlayerId,
          )
          await continueRoundCompletion(code)
        }
        continue
      }

      // Case 1 — picking-phase round timer (S2-10)
      if (phase === 'picking') {
        const expiresAt = await state.getRoundTimerExpiresAt(code)
        if (!expiresAt) continue
        const round = await state.getCurrentRound(code)
        const [roundRow] = await db
          .select({ czarPlayerId: gameRounds.czarPlayerId })
          .from(gameRounds)
          .where(and(eq(gameRounds.sessionId, s.id), eq(gameRounds.matchId, s.currentMatchId!)))
          .orderBy(desc(gameRounds.roundNum))
          .limit(1)
        const czarId = roundRow?.czarPlayerId ?? null
        const ms = expiresAt - Date.now()
        await armRoundTimer(code, round, czarId, expiresAt, currentRow.id)
        engineLogger.info({ code, round, ms: Math.max(0, ms) }, 'round timer restored')
        continue
      }

      // The shared continuation owns the durable pause and retry. Await it so
      // readiness cannot report work complete before its effects finish.
      if (phase === 'transition') {
        if (await state.getPostResolveResumeAt(code)) await continueRoundCompletion(code)
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
          .where(and(eq(gameRounds.sessionId, s.id), eq(gameRounds.matchId, s.currentMatchId!)))
          .orderBy(desc(gameRounds.roundNum))
          .limit(1)
        const czarId = roundRow?.czarPlayerId ?? null
        const players = await state.getAllPlayers(code)
        const config = s.config as GameConfig
        const roundId = await currentRoundIdentity(code)
        if (!roundId) continue
        await transitionAfterReveal(code, config, czarId, players, roundId)
        engineLogger.info({ code }, 'reveal phase fast-forwarded')
        continue
      }
    } catch (err) {
      failed = true
      failures.push(err)
      engineLogger.warn({ err, code: s.code }, 'room recovery remains pending')
    } finally {
      if (!failed) recovered++
      report()
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Room recovery incomplete')
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
    .where(
      and(eq(gameRounds.sessionId, session.id), eq(gameRounds.matchId, session.currentMatchId!)),
    )
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
    (p) =>
      p.status === 'active' &&
      p.role === 'player' &&
      p.id !== czarId &&
      !p.isRando &&
      !skippedSet.has(p.id),
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
    .where(
      and(eq(gameRounds.sessionId, session.id), eq(gameRounds.matchId, session.currentMatchId!)),
    )
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
    (p) =>
      p.status === 'active' &&
      p.role === 'player' &&
      p.id !== czarId &&
      !p.isRando &&
      !skippedSet.has(p.id),
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
  await expireRoomStateKeys(code, [resolvingKey(code)])

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
  await redis
    .multi()
    .set(subOrderKey(code), orderJson)
    .eval(EXPIRE_ROOM_KEY_LUA, 1, subOrderKey(code))
    .exec()

  const roundId = await currentRoundIdentity(code)
  if (!roundId) return
  await state.setPhase(code, 'reveal')
  for (const player of players.filter(
    (player) => config.rules.includes('godmode') && !player.isRando,
  )) {
    await state.publishEvent(code, {
      type: 'my_submission_ids',
      playerId: player.id,
      submissionIds: order.flatMap((key, index) =>
        resolvePlayerId(key) === player.id ? [String(index)] : [],
      ),
    })
  }
  await state.publishEvent(code, { type: 'reveal_start', submissionCount: order.length })
  for (let i = 0; i < order.length; i++) {
    const sub = submissions[order[i]!]
    if (!sub) continue
    await sleep(REVEAL_STAGGER)
    if (
      !(await state.publishRoundReveals(code, roundId, [{ submissionIndex: i, fills: sub.fills }]))
    )
      return
  }

  await transitionAfterReveal(code, config, czarId, players, roundId)
}

// Boot recovery can fast-forward an interrupted reveal. The handoff is
// claimed against the original round, so a fallback or newer round wins
// over any sleeping callback.
async function transitionAfterReveal(
  code: string,
  config: GameConfig,
  czarId: string | null,
  players: GamePlayer[],
  roundId: string,
): Promise<void> {
  const phase = config.rules.includes('survival')
    ? 'eliminating'
    : config.rules.includes('godmode')
      ? 'waiting'
      : config.rules.includes('serious_business')
        ? 'ranking'
        : 'judging'
  const firstPlayer =
    phase === 'eliminating'
      ? players.find(
          (p) => p.status === 'active' && p.role === 'player' && p.id !== czarId && !p.isRando,
        )
      : undefined
  if (!(await state.advanceRevealedRound(code, roundId, phase, firstPlayer?.id))) return
  if (firstPlayer)
    await state.publishEvent(code, { type: 'elimination_turn', playerId: firstPlayer.id })
  if (phase === 'waiting') await state.publishEvent(code, { type: 'vote_tally', votes: {} })
  // A permanent drop can race the reveal-to-judging handoff. Whichever
  // phase it observed, the shared claim lets exactly one fallback finish.
  if (czarId && phase !== 'waiting' && (await state.getPlayer(code, czarId))?.status === 'dropped')
    await resolveDroppedCzar(code, czarId, roundId, config, phase)
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
        .where(
          and(
            and(
              eq(gameRounds.sessionId, session.id),
              eq(gameRounds.matchId, session.currentMatchId!),
            ),
            eq(gameRounds.roundNum, round),
          ),
        )
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
  const raw = await redis.eval(
    `${ROOM_LIFETIME_LUA}
    local current = redis.call('HGET', KEYS[2], ARGV[1])
    if current then return current end
    local fills = {}
    for i=1,tonumber(ARGV[2]) do
      local card = redis.call('LPOP', KEYS[1])
      if not card then break end
      table.insert(fills, {id=card, text=''})
    end
    local submission = cjson.encode({submissionId=ARGV[3], playerId=ARGV[1], fills=fills})
    redis.call('HSET', KEYS[2], ARGV[1], submission)
    expireRoomKey(KEYS[2])
    return submission
  `,
    2,
    KEYS.deckWhite(code),
    `${KEYS.round(code)}:submissions`,
    rando.id,
    pick,
    createId(),
    ROOM_TTL_SECONDS,
  )
  const reserved = JSON.parse(String(raw)) as Submission
  const drawn = Object.values(reserved.fills).map((card) => card.id)
  if (drawn.length === 0) return
  const rows = await db.select().from(whiteCards).where(inArray(whiteCards.id, drawn))
  const fills: Card[] = drawn.map((id) => {
    const c = rows.find((x) => x.id === id)
    return c ? { id: c.id, text: c.text } : { id, text: '' }
  })
  const submission: Submission = { ...reserved, fills }
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
    .where(
      and(
        and(eq(gameRounds.sessionId, session.id), eq(gameRounds.matchId, session.currentMatchId!)),
        eq(gameRounds.roundNum, round),
      ),
    )
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
  await resolvePickedWinner(code, czarId, submissionId, roundId, 'judging', onOutcome, true)
}

async function resolvePickedWinner(
  code: string,
  czarId: string,
  submissionId: string,
  roundId: string,
  phase: 'judging' | 'reveal',
  onOutcome?: (accepted: boolean) => void,
  renewLifetime = false,
): Promise<void> {
  const submissions = await state.getSubmissions(code)
  const winnerKey = await resolveSubmissionKey(code, submissionId)
  if (!winnerKey || !submissions[winnerKey])
    throw new GameCommandError('invalid_state', 'Command failed')
  const winnerPlayerId = resolvePlayerId(winnerKey)

  const decision = decideNormalRound({
    winnerKey,
    submissions,
    players: await state.getAllPlayers(code),
  })
  if (!decision) throw new Error('winner not found')
  const claimed = await claimCompletionIntent(
    code,
    roundId,
    phase,
    {
      winnerPlayerId,
      submissionId,
      submissions,
      czarId,
      adjustments: decision.scoreAdjustments,
      winningFills: decision.winningFills,
    },
    renewLifetime,
  )
  onOutcome?.(claimed)
  if (claimed) await continueRoundCompletion(code)
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
    roundNumber?: number
    roundId: string
    matchId?: string
  },
): Promise<void> {
  const [session] = await db
    .select({ id: gameSessions.id, currentMatchId: gameSessions.currentMatchId })
    .from(gameSessions)
    .where(eq(gameSessions.code, code))
  if (!session) return
  const round = outcome.roundNumber ?? (await state.getCurrentRound(code))
  await db
    .update(gameRounds)
    .set({
      winnerPlayerId: outcome.winnerPlayerId,
      winningSubmissionFills: outcome.winningFills,
      ...(outcome.ranking !== undefined ? { ranking: outcome.ranking } : {}),
      ...(outcome.voteTally !== undefined ? { voteTally: outcome.voteTally } : {}),
    })
    .where(
      and(
        eq(gameRounds.sessionId, session.id),
        eq(gameRounds.matchId, outcome.matchId ?? session.currentMatchId!),
        eq(gameRounds.id, outcome.roundId),
        eq(gameRounds.roundNum, round),
      ),
    )
  await touchSessionActivity(code)
}

// The intent survives round-hash replacement. Every irreversible Redis effect
// commits with its checkpoint; SQL outcome updates are safe to repeat.
type CompletionIntent = {
  roundId: string
  // Optional only for pending intents written before the match migration.
  matchId?: string
  roundNumber: number
  mode?: 'normal' | 'survival' | 'godmode' | 'serious_business'
  winnerPlayerId: string
  submissionId: string
  submissions: Record<string, Submission>
  czarId: string | null
  adjustments: { playerId: string; delta: number }[]
  winningFills: Card[]
  ranking?: Submission[]
  voteTally?: Record<string, number>
  fallbackEliminations?: { submissionId: string; byPlayerId: string }[]
}

async function claimCompletionIntent(
  code: string,
  roundId: string,
  phase: string,
  outcome: Omit<CompletionIntent, 'roundId' | 'roundNumber' | 'matchId'>,
  renewLifetime = false,
): Promise<boolean> {
  // Match identity was installed with the round, before votes/eliminations.
  // No SQL may precede the durable intent after a terminal action is accepted.
  const [rawConfig, matchId] = await redis.hmget(KEYS.game(code), 'config', 'matchId')
  const config = JSON.parse(rawConfig ?? '{}') as GameConfig
  const mode = config.rules?.includes('survival')
    ? 'survival'
    : config.rules?.includes('godmode')
      ? 'godmode'
      : config.rules?.includes('serious_business')
        ? 'serious_business'
        : 'normal'
  return (
    (await redis.eval(
      `${ROOM_LIFETIME_LUA}
    if not redis.call('HGET', KEYS[2], 'status') then return 0 end
    if redis.call('HGET', KEYS[1], 'roundId') ~= ARGV[1]
      or redis.call('HGET', KEYS[1], 'phase') ~= ARGV[2]
      or redis.call('HEXISTS', KEYS[1], 'outcomeClaim') == 1 then return 0 end
    redis.call('HSET', KEYS[1], 'outcomeClaim', ARGV[1], 'winningPlayerId', ARGV[3], 'winningSubmissionId', ARGV[4], 'phase', 'transition')
    redis.call('HSET', KEYS[2], 'completionIntent', ARGV[5])
    redis.call('HDEL', KEYS[2], 'completionScores', 'completionPublished', 'completionCards', 'completionEndPublished', 'completionResumeAt', 'completionGameEnd', 'completionGameOverPublished')
    expireRoomKey(KEYS[1])
    expireRoomKey(KEYS[2])
    if ARGV[7] == '1' then renewRoomState(KEYS[2]) end
    return 1`,
      2,
      KEYS.round(code),
      KEYS.game(code),
      roundId,
      phase,
      outcome.winnerPlayerId,
      outcome.submissionId,
      JSON.stringify({
        ...outcome,
        mode,
        roundId,
        matchId: matchId ?? undefined,
        roundNumber: await state.getCurrentRound(code),
      }),
      ROOM_TTL_SECONDS,
      renewLifetime ? '1' : '',
    )) === 1
  )
}

async function recordSingleWinnerIntent(
  code: string,
  roundId: string,
  winnerKey: string,
  submissions: Record<string, Submission>,
  submissionId: string,
  czarId: string | null,
  voteTally?: Record<string, number>,
): Promise<void> {
  const decision = decideNormalRound({
    winnerKey,
    submissions,
    players: await state.getAllPlayers(code),
  })
  if (!decision) throw new Error('winner not found')
  await claimCompletionIntent(code, roundId, voteTally ? 'waiting' : 'eliminating', {
    winnerPlayerId: decision.winnerPlayerId,
    submissionId,
    submissions,
    czarId,
    adjustments: decision.scoreAdjustments,
    winningFills: decision.winningFills,
    voteTally,
  })
}

// Concurrent commands/recovery callers in a process share the continuation.
// A killed process releases ownership automatically; durable checkpoints remain.
const completionRuntime = globalThis as typeof globalThis & {
  __cabCompletionTasks?: Map<string, Promise<void>>
  __cabResettingRooms?: Set<string>
  __cabCompletionRetries?: Map<string, ReturnType<typeof setTimeout>>
}
const completionTasks = (completionRuntime.__cabCompletionTasks ??= new Map<
  string,
  Promise<void>
>())
const resettingRooms = (completionRuntime.__cabResettingRooms ??= new Set<string>())
const completionRetries = (completionRuntime.__cabCompletionRetries ??= new Map<
  string,
  ReturnType<typeof setTimeout>
>())
async function continueRoundCompletion(code: string): Promise<void> {
  if (resettingRooms.has(code)) return
  const existing = completionTasks.get(code)
  if (existing) return existing
  const task = runRoundCompletion(code)
  completionTasks.set(code, task)
  try {
    await task
    const retry = completionRetries.get(code)
    if (retry) clearTimeout(retry)
    completionRetries.delete(code)
  } catch (err) {
    if (!completionRetries.has(code)) {
      const retry = setTimeout(() => {
        completionRetries.delete(code)
        void continueRoundCompletion(code).catch((err) =>
          engineLogger.warn({ err, code }, 'round completion retry pending'),
        )
      }, 1000)
      retry.unref()
      completionRetries.set(code, retry)
    }
    throw err
  } finally {
    completionTasks.delete(code)
  }
}

// Round IDs also fence pre-migration intents: round number 1 in a replay
// must never be mistaken for round number 1 in the completed match.
async function completionBelongsToCurrentMatch(
  code: string,
  intent: CompletionIntent,
): Promise<boolean> {
  const [row] = await db
    .select({ id: gameRounds.id })
    .from(gameRounds)
    .innerJoin(gameSessions, eq(gameSessions.id, gameRounds.sessionId))
    .where(
      and(
        eq(gameSessions.code, code),
        eq(gameRounds.id, intent.roundId),
        eq(gameRounds.matchId, gameSessions.currentMatchId),
        ...(intent.matchId ? [eq(gameRounds.matchId, intent.matchId)] : []),
      ),
    )
  return Boolean(row)
}

async function runRoundCompletion(code: string): Promise<void> {
  const raw = await redis.hget(KEYS.game(code), 'completionIntent')
  if (!raw) return finalizeRoundAfterPause(code)
  const intent = JSON.parse(raw) as CompletionIntent
  if (!(await completionBelongsToCurrentMatch(code, intent))) return
  if (await redis.hget(KEYS.game(code), 'completionEndPublished')) {
    await finalizeRoundAfterPause(code)
    return
  }
  await redis.eval(
    `
    if redis.call('HGET', KEYS[1], 'completionIntent') ~= ARGV[1]
      or redis.call('HEXISTS', KEYS[1], 'completionScores') == 1 then return end
    for _, adjustment in ipairs(cjson.decode(ARGV[2])) do
      local raw = redis.call('HGET', KEYS[2], adjustment.playerId)
      if raw then
        local p = cjson.decode(raw)
        p.score = math.max(0, (p.score or 0) + adjustment.delta)
        redis.call('HSET', KEYS[2], adjustment.playerId, cjson.encode(p))
      end
    end
    redis.call('HSET', KEYS[1], 'completionScores', '1')
  `,
    2,
    KEYS.game(code),
    KEYS.players(code),
    raw,
    JSON.stringify(intent.adjustments),
  )
  // SQL must complete before the single public outcome is emitted.
  await finishClaimedReveal(code, intent.roundId, intent.submissions)
  await persistRoundOutcome(code, intent)
  if (intent.ranking)
    await redis.eval(
      `
    if redis.call('HGET', KEYS[1], 'roundId') == ARGV[1] then redis.call('HSET', KEYS[1], 'ranking', ARGV[2]) end
  `,
      1,
      KEYS.round(code),
      intent.roundId,
      JSON.stringify(intent.ranking),
    )
  const event = intent.ranking
    ? {
        type: 'round_ranked',
        winningPlayerId: intent.winnerPlayerId,
        winningSubmissionId: intent.submissionId,
        ranking: intent.ranking,
        scoresDelta: Object.fromEntries(intent.adjustments.map((a) => [a.playerId, a.delta])),
      }
    : {
        type: 'round_won',
        winningPlayerId: intent.winnerPlayerId,
        winningSubmissionId: intent.submissionId,
        winnerId: intent.winnerPlayerId,
        submissionId: intent.submissionId,
        scores: toPlayerScores(await state.getAllPlayers(code), intent.czarId),
      }
  const published = await redis.eval(
    `
    if redis.call('HGET', KEYS[1], 'completionIntent') ~= ARGV[1]
      or redis.call('HEXISTS', KEYS[1], 'completionPublished') == 1 then return end
    for _, event in ipairs(cjson.decode(ARGV[3])) do redis.call('PUBLISH', KEYS[2], cjson.encode(event)) end
    redis.call('PUBLISH', KEYS[2], ARGV[2])
    redis.call('HSET', KEYS[1], 'completionPublished', '1')
    return 1
  `,
    2,
    KEYS.game(code),
    KEYS.channel(code),
    raw,
    JSON.stringify(event),
    JSON.stringify(
      (intent.fallbackEliminations ?? []).map((elimination) => ({
        type: 'card_eliminated',
        ...elimination,
      })),
    ),
  )
  if (published === 1) {
    const rules =
      (JSON.parse((await redis.hget(KEYS.game(code), 'config')) ?? '{}') as GameConfig).rules ?? []
    const mode =
      intent.mode ??
      (intent.ranking
        ? 'serious_business'
        : intent.voteTally
          ? 'godmode'
          : rules.includes('survival')
            ? 'survival'
            : 'normal')
    const name =
      mode === 'serious_business'
        ? 'cab_round_ranked'
        : mode === 'godmode'
          ? 'cab_round_voted'
          : mode === 'survival'
            ? 'cab_round_eliminated'
            : 'cab_winner_picked'
    const actor =
      mode === 'normal' && intent.czarId
        ? await distinctIdFor(code, intent.czarId)
        : await distinctIdForHost(code)
    captureServerEvent(actor, name, {
      roomCode: code,
      winnerId: intent.winnerPlayerId,
      ...(mode === 'normal'
        ? { isRando: (await state.getPlayer(code, intent.winnerPlayerId))?.isRando ?? false }
        : {}),
      ...(mode === 'survival'
        ? { totalEliminations: Object.keys(intent.submissions).length - 1 }
        : {}),
      ...(intent.voteTally ? { voteSpread: intent.voteTally } : {}),
      ...(intent.ranking
        ? { top3: intent.ranking.map((submission) => submission.playerId).filter(Boolean) }
        : {}),
    })
  }
  await endRound(code, Object.keys(intent.submissions), intent.roundId)
}

async function completeRoundCards(code: string, roundId: string): Promise<void> {
  const raw = await redis.hget(KEYS.game(code), 'completionIntent')
  if (!raw) return
  const intent = JSON.parse(raw) as CompletionIntent
  if (intent.roundId !== roundId) return
  const [roundRow] = await db
    .select({ blackCardId: gameRounds.blackCardId })
    .from(gameRounds)
    .where(eq(gameRounds.id, roundId))
  const order = await getSubOrder(code)
  const resolved = order.map((key, index) => ({
    submissionId: String(index),
    fills: intent.submissions[key]?.fills ?? [],
    ...(intent.submissions[key]?.eliminated ? { eliminated: true } : {}),
  }))
  // Keep private action receipts through the result pause, even after card
  // cleanup clears live submissions and wager flags. Each snapshot selects
  // only its authenticated recipient's receipt.
  const choices = await redis.hgetall(voterChoicesKeyFor(code))
  const resolvedRecipients = Object.fromEntries(
    (await state.getAllPlayers(code)).map((player) => [
      player.id,
      {
        myHasGambled: player.hasGambled ?? false,
        mySubmissionCount:
          Number(!!intent.submissions[player.id]) +
          Number(!!intent.submissions[`${player.id}:gamble`]),
        mySubmissionIds: order.flatMap((key, index) =>
          resolvePlayerId(key) === player.id ? [String(index)] : [],
        ),
        myVotedSubmissionId: choices[player.id] ?? null,
      },
    ]),
  )
  // Card movement, activation, and the recoverable pause cursor commit together.
  const randoms = Array.from(
    {
      length:
        (await redis.llen(KEYS.discardWhite(code))) +
        Object.values(intent.submissions).reduce(
          (n, submission) => n + submission.fills.length,
          0,
        ) +
        100,
    },
    () => randomInt(0, 0x7fffffff),
  )
  const activated = await redis.eval(
    `${ROOM_LIFETIME_LUA}
    if redis.call('HGET', KEYS[1], 'completionIntent') ~= ARGV[1]
      or redis.call('HEXISTS', KEYS[1], 'completionCards') == 1 then return nil end
    local intent = cjson.decode(ARGV[1])
    if ARGV[7] ~= '' then redis.call('RPUSH', KEYS[8], ARGV[7]) end
    for _, submission in pairs(intent.submissions) do
      for _, card in ipairs(submission.fills) do redis.call('RPUSH', KEYS[5], card.id) end
    end
    local players = redis.call('HGETALL', KEYS[3])
    local active = 0
    for i=1,#players,2 do
      local p = cjson.decode(players[i+1])
      if p.status == 'active' and p.role == 'player' then active = active + 1 end
    end
    if redis.call('LLEN', KEYS[4]) < active * 3 then
      local ids = redis.call('LRANGE', KEYS[5], 0, -1)
      local randoms = cjson.decode(ARGV[4])
      for i=#ids,2,-1 do
        local j = (randoms[((i-2) % #randoms)+1] % i) + 1
        ids[i],ids[j] = ids[j],ids[i]
      end
      for _, id in ipairs(ids) do redis.call('RPUSH', KEYS[4], id) end
      redis.call('DEL', KEYS[5])
    end
    local refill = {}
    for key,_ in pairs(intent.submissions) do refill[string.gsub(key, ':gamble$', '')] = true end
    local activated = {}
    for i=1,#players,2 do
      local p = cjson.decode(players[i+1])
      if p.hasGambled then p.hasGambled = false end
      if p.status == 'queued' then
        p.status = 'active'
        redis.call('RPUSH', KEYS[6], p.id)
        table.insert(activated, p.id)
        refill[p.id] = true
      end
      redis.call('HSET', KEYS[3], players[i], cjson.encode(p))
    end
    for pid,_ in pairs(refill) do
      local hand = ARGV[3] .. pid
      for i=redis.call('LLEN', hand)+1,10 do
        local id = redis.call('LPOP', KEYS[4])
        if not id then break end
        redis.call('RPUSH', hand, id)
      end
      expireRoomKey(hand)
    end
    redis.call('HSET', KEYS[2], 'resolvedSubmissions', ARGV[2], 'resolvedRecipients', ARGV[8], 'resolvedVoteTally', ARGV[9], 'submissions', '{}', 'phase', 'transition', 'postResolveResumeAt', ARGV[6])
    redis.call('HSET', KEYS[1], 'completionCards', cjson.encode(activated), 'completionResumeAt', ARGV[6])
    for i=1,#KEYS do expireRoomKey(KEYS[i]) end
    redis.call('DEL', KEYS[7])
    return cjson.encode(activated)
  `,
    8,
    KEYS.game(code),
    KEYS.round(code),
    KEYS.players(code),
    KEYS.deckWhite(code),
    KEYS.discardWhite(code),
    KEYS.czarOrder(code),
    `${KEYS.round(code)}:submissions`,
    KEYS.discardBlack(code),
    raw,
    JSON.stringify(resolved),
    `game:${code}:hand:`,
    JSON.stringify(randoms),
    ROOM_TTL_SECONDS,
    Date.now() + roundResultPauseMs(),
    roundRow?.blackCardId ?? '',
    JSON.stringify(resolvedRecipients),
    JSON.stringify(intent.voteTally ?? {}),
  )
  const activation = Object.values(
    JSON.parse(String(activated ?? (await redis.hget(KEYS.game(code), 'completionCards')) ?? '[]')),
  ) as string[]
  const recipients = [
    ...new Set([...Object.keys(intent.submissions).map(resolvePlayerId), ...activation]),
  ]
  const handEvents = []
  for (const pid of recipients) {
    const ids = await state.getHand(code, pid)
    const cards = ids.length
      ? await db.select().from(whiteCards).where(inArray(whiteCards.id, ids))
      : []
    handEvents.push({
      type: 'hand_update',
      playerId: pid,
      hand: ids
        .map((id) => cards.find((c) => c.id === id)!)
        .filter(Boolean)
        .map((c) => ({ id: c.id, text: c.text })),
    })
  }
  await redis.eval(
    `
    if redis.call('HGET', KEYS[1], 'completionIntent') ~= ARGV[1]
      or redis.call('HEXISTS', KEYS[1], 'completionEndPublished') == 1 then return end
    for _, event in ipairs(cjson.decode(ARGV[2])) do redis.call('PUBLISH', KEYS[2], cjson.encode(event)) end
    redis.call('PUBLISH', KEYS[2], ARGV[3])
    for i=3,#KEYS do redis.call('DEL', KEYS[i]) end
    redis.call('HSET', KEYS[1], 'completionEndPublished', '1')
  `,
    9,
    KEYS.game(code),
    KEYS.channel(code),
    subOrderKey(code),
    resolvingKey(code),
    revealedKey(code),
    voteTallyKeyFor(code),
    tieKeyFor(code),
    votersKeyFor(code),
    voterChoicesKeyFor(code),
    raw,
    JSON.stringify(handEvents),
    JSON.stringify({ type: 'round_end', activatedPlayers: activation }),
  )
}

export async function endRound(
  code: string,
  _submitterIds: string[],
  roundId: string,
): Promise<void> {
  await completeRoundCards(code, roundId)
  const resumeAt = await state.getPostResolveResumeAt(code)
  if (resumeAt === null) return
  await sleep(Math.max(0, resumeAt - Date.now()))
  await finalizeRoundAfterPause(code)
}

// Read the pause cursor without consuming it. Startup and runtime retries use
// the same continuation; acknowledgment follows durable end-game/round startup.
async function finalizeRoundAfterPause(code: string): Promise<void> {
  const raw = await redis.hget(KEYS.game(code), 'completionIntent')
  const intent = raw ? (JSON.parse(raw) as CompletionIntent) : null
  const cursor = intent
    ? Number(await redis.hget(KEYS.game(code), 'completionResumeAt'))
    : await state.getPostResolveResumeAt(code)
  if (!cursor) return
  if (cursor > Date.now()) await sleep(cursor - Date.now())
  if (resettingRooms.has(code)) return
  if (intent && !(await completionBelongsToCurrentMatch(code, intent))) return
  if (raw && (await redis.hget(KEYS.game(code), 'completionIntent')) !== raw) return
  const acknowledge = async () => {
    if (raw)
      await redis.eval(
        `
      if redis.call('HGET', KEYS[1], 'completionIntent') ~= ARGV[1] then return end
      redis.call('HDEL', KEYS[1], 'completionIntent', 'completionScores', 'completionPublished', 'completionCards', 'completionEndPublished', 'completionResumeAt', 'completionGameEnd', 'completionGameOverPublished')
      if redis.call('HGET', KEYS[2], 'roundId') == ARGV[2] then redis.call('HDEL', KEYS[2], 'postResolveResumeAt') end
    `,
        2,
        KEYS.game(code),
        KEYS.round(code),
        raw,
        intent!.roundId,
      )
    if (!raw)
      await redis.eval(
        `
      if redis.call('HGET', KEYS[1], 'postResolveResumeAt') == ARGV[1] then redis.call('HDEL', KEYS[1], 'postResolveResumeAt') end
    `,
        1,
        KEYS.round(code),
        cursor,
      )
  }

  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) return
  // The session may have been ended/reset/abandoned out from under us
  // (e.g. host clicked rematch after the round resolved but before the
  // pause finished). Bail rather than start a phantom next round.
  const pendingEnd = await redis.hget(KEYS.game(code), 'completionGameEnd')
  if (pendingEnd) {
    const target = JSON.parse(pendingEnd) as { mode: GameOverMode; winnerId?: string }
    await endGame(code, target.mode, target.winnerId)
    await acknowledge()
    return
  }
  if (session.status !== 'active') return
  const config = session.config as GameConfig
  const conclude = async (mode: GameOverMode, winnerId?: string) => {
    await redis.hset(KEYS.game(code), 'completionGameEnd', JSON.stringify({ mode, winnerId }))
    await endGame(code, mode, winnerId)
    await acknowledge()
  }
  const refreshed = await state.getAllPlayers(code)

  // Happy Ending: this was the forced "Make a Haiku" final round —
  // end now regardless of score; the Haiku round winner wins the game.
  if (await redis.hget(KEYS.game(code), 'happyEndingFinal')) {
    const { winningPlayerId } = await state.getRoundOutcome(code)
    await conclude('happy_ending', winningPlayerId ?? undefined)
    await redis.hdel(KEYS.game(code), 'happyEndingFinal', 'happyEndingArmed')
    return
  }

  const winnerPlayer = refreshed.find((p) => p.score >= config.roundsToWin)
  if (winnerPlayer) {
    await conclude(winnerPlayer.isRando ? 'rando_won' : 'normal', winnerPlayer.id)
    return
  }

  const nextRound = intent ? intent.roundNumber + 1 : (await state.getCurrentRound(code)) + 1
  try {
    await startRound(code, nextRound)
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'deck_exhausted') throw err
  }
  await acknowledge()
}

export async function endGame(code: string, mode: GameOverMode, winnerId?: string): Promise<void> {
  const players = await state.getAllPlayers(code)
  const finalScores = toPlayerScores(players, null)

  const updated = await db.transaction(async (tx) => {
    const [room] = await tx
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.code, code))
      .for('update')
    if (!room) return undefined
    const endedAt = new Date()
    await tx
      .update(gameSessions)
      .set({ status: 'ended', endedAt, endMode: mode, winnerPlayerId: winnerId ?? null })
      .where(eq(gameSessions.id, room.id))
    if (room.currentMatchId)
      await tx
        .update(gameMatches)
        .set({
          status: 'ended',
          endedAt,
          endMode: mode,
          winnerPlayerId: winnerId ?? null,
          finalPlayers: players,
        })
        .where(
          and(
            eq(gameMatches.id, room.currentMatchId),
            inArray(gameMatches.status, ['active', 'paused']),
          ),
        )
    const [match] = room.currentMatchId
      ? await tx.select().from(gameMatches).where(eq(gameMatches.id, room.currentMatchId))
      : []
    return { createdAt: match?.startedAt ?? room.createdAt }
  })

  await state.updateLiveRoom(code, { status: 'ended' })
  const completion = await redis.hget(KEYS.game(code), 'completionIntent')
  const event = JSON.stringify({ type: 'game_over', finalScores, winnerId: winnerId ?? '', mode })
  if (completion)
    await redis.eval(
      `
    if redis.call('HGET', KEYS[1], 'completionIntent') ~= ARGV[1]
      or redis.call('HEXISTS', KEYS[1], 'completionGameOverPublished') == 1 then return end
    redis.call('PUBLISH', KEYS[2], ARGV[2])
    redis.call('HSET', KEYS[1], 'completionGameOverPublished', '1')
  `,
      2,
      KEYS.game(code),
      KEYS.channel(code),
      completion,
      event,
    )
  else await redis.publish(KEYS.channel(code), event)

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
// must be `ended` — claim it atomically before clearing state.
export async function resetGame(
  code: string,
  mode: ResetMode,
  hostPlayerId?: string,
): Promise<void> {
  // A reset cannot overtake a continuation that is awaiting SQL or its pause.
  // Block retry entry first, then drain the existing owner before wiping state.
  if (resettingRooms.has(code))
    throw new GameCommandError('invalid_state', 'A reset is already in progress')
  resettingRooms.add(code)
  try {
    await completionTasks.get(code)?.catch(() => {})
    await performResetGame(code, mode, hostPlayerId)
  } finally {
    resettingRooms.delete(code)
  }
}

async function performResetGame(
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
  await state.updateLiveRoom(
    code,
    { status: 'resetting', currentRound: '0', czarIndex: '-1' },
    hostPlayerId,
    [
      KEYS.round(code),
      KEYS.deckBlack(code),
      KEYS.deckWhite(code),
      KEYS.discardWhite(code),
      KEYS.discardBlack(code),
      KEYS.czarOrder(code),
      ...before.map((p) => KEYS.hand(code, p.id)),
    ],
    'ended',
    true,
  )
  await redis.hdel(
    KEYS.game(code),
    'matchId',
    'czarStartOffset',
    'happyEndingArmed',
    'happyEndingFinal',
  )

  // Keep prior rounds and their referenced synthetic identities. Only live
  // membership is retired; the next match gets a new Rando identity.
  await db
    .update(gamePlayers)
    .set({ status: 'dropped' })
    .where(and(eq(gamePlayers.sessionId, session.id), eq(gamePlayers.isRando, true)))

  await redis.hdel(
    KEYS.game(code),
    'completionIntent',
    'completionScores',
    'completionPublished',
    'completionCards',
    'completionEndPublished',
    'completionResumeAt',
    'completionGameEnd',
    'completionGameOverPublished',
    'roundStartCard',
    'roundStartPublished',
  )
  for (const p of before) {
    // Not carried: Rando (re-created by startGame) and terminally
    // dropped players (no live socket / cleared session — they re-join
    // by code into the new lobby). Remove from the live roster.
    if (p.isRando || p.status === 'dropped') {
      await redis.hdel(KEYS.players(code), p.id)
      continue
    }
    // Reset game flags only. Participation and the live connection's grace
    // deadline survive; a rematch cannot revive a disconnected participant.
    await state.updatePlayer(code, p.id, {
      score: 0,
      discardsUsed: 0,
      hasGambled: false,
    })
    await db
      .update(gamePlayers)
      .set({ score: 0, status: p.status, discardsUsed: 0 })
      .where(eq(gamePlayers.id, p.id))
  }

  // The game is replayable from a clean slate — clear the ended outcome.
  await db
    .update(gameSessions)
    .set({
      currentMatchId: null,
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
  await startMatch(code, hostPlayerId, 'active')
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
export async function voidRound(
  code: string,
  reason: string,
  expectedRoundId?: string,
  droppedPlayerId?: string,
): Promise<void> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session || session.status !== 'active') return
  const [roundRow] = await db
    .select()
    .from(gameRounds)
    .where(
      and(eq(gameRounds.sessionId, session.id), eq(gameRounds.matchId, session.currentMatchId!)),
    )
    .orderBy(desc(gameRounds.roundNum))
    .limit(1)
  if (!roundRow || (expectedRoundId && roundRow.id !== expectedRoundId)) return
  // Returning cards, clearing the abandoned round, and recording the next
  // step are one operation. A retry cannot return/discard cards twice.
  const returned = (await redis.eval(
    `${ROOM_LIFETIME_LUA}
    if redis.call('HGET', KEYS[1], 'roundId') ~= ARGV[1] then return nil end
    if redis.call('HGET', KEYS[1], 'voidPreparedRoundId') == ARGV[1] then
      return redis.call('HGET', KEYS[1], 'voidReturnedPlayers') or '[]' end
    local hands = {}
    local submissions = redis.call('HGETALL', KEYS[3])
    for i=1,#submissions,2 do
      local pid = string.gsub(submissions[i], ':gamble$', '')
      local raw = redis.call('HGET', KEYS[2], pid)
      if raw and not cjson.decode(raw).isRando then
        local hand = ARGV[5] .. pid
        local sub = cjson.decode(submissions[i+1])
        for _,card in ipairs(sub.fills) do redis.call('RPUSH', hand, card.id) end
        expireRoomKey(hand)
        table.insert(hands, pid)
      end
    end
    local players = redis.call('HGETALL', KEYS[2])
    for i=1,#players,2 do
      local player = cjson.decode(players[i+1])
      player.hasGambled = false
      redis.call('HSET', KEYS[2], players[i], cjson.encode(player))
    end
    redis.call('RPUSH', KEYS[4], ARGV[3])
    expireRoomKey(KEYS[4])
    redis.call('HSET', KEYS[1], 'phase', 'transition', 'voidPreparedRoundId', ARGV[1], 'voidReturnedPlayers', cjson.encode(hands))
    redis.call('HDEL', KEYS[1], 'eliminationTurnPlayerId')
    for i=6,#KEYS do redis.call('DEL', KEYS[i]) end
    redis.call('DEL', KEYS[3])
    if ARGV[6] ~= '' then
      local raw = redis.call('HGET', KEYS[5], ARGV[6])
      if raw then
        local intent = cjson.decode(raw)
        intent.voidNextRound = tonumber(ARGV[2]) + 1
        intent.voidReturnedPlayers = hands
        redis.call('HSET', KEYS[5], ARGV[6], cjson.encode(intent))
      end
    end
    redis.call('PUBLISH', ARGV[7], ARGV[8])
    return cjson.encode(hands)
  `,
    13,
    KEYS.round(code),
    KEYS.players(code),
    `${KEYS.round(code)}:submissions`,
    KEYS.discardBlack(code),
    KEYS.drops(code),
    `${KEYS.round(code)}:skipped`,
    subOrderKey(code),
    resolvingKey(code),
    revealedKey(code),
    voteTallyKeyFor(code),
    tieKeyFor(code),
    votersKeyFor(code),
    voterChoicesKeyFor(code),
    roundRow.id,
    roundRow.roundNum,
    roundRow.blackCardId,
    ROOM_TTL_SECONDS,
    `game:${code}:hand:`,
    droppedPlayerId ?? '',
    KEYS.channel(code),
    JSON.stringify({ type: 'round_voided', round: roundRow.roundNum, reason }),
  )) as string | null
  if (returned === null) return
  const recipients: unknown = JSON.parse(returned)
  if (Array.isArray(recipients))
    for (const playerId of recipients as string[]) await publishHandUpdate(code, playerId)
  await startRound(code, roundRow.roundNum + 1)
}

// Ownership follows the longest-present participating human, including queued
// players and reconnect grace. Spectators and Rando never become host. A room
// without an eligible human has no host until a human joins again.
export async function migrateHost(code: string): Promise<string | null> {
  // SQL is the committed ownership source. The room-scoped intent survives
  // failed/uncertain COMMITs and Redis outages until a later authenticated
  // action reconciles it. Retry once here; never guess whether COMMIT won.
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await db.transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(gameSessions)
          .where(eq(gameSessions.code, code))
          .for('update')
        if (!session) return
        const eligible = (await state.getAllPlayers(code))
          .filter(
            (p) =>
              (p.status === 'active' || p.status === 'queued') && p.role === 'player' && !p.isRando,
          )
          .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.id.localeCompare(b.id))
        const hostId =
          eligible.find((p) => p.id === session.hostPlayerId)?.id ?? eligible[0]?.id ?? null
        await state.updateLiveRoom(code, { hostSuccessionPending: '1' })
        if (hostId === session.hostPlayerId) return
        await tx
          .update(gameSessions)
          .set({ hostPlayerId: hostId })
          .where(eq(gameSessions.id, session.id))
        await tx
          .update(gamePlayers)
          .set({ isHost: false })
          .where(eq(gamePlayers.sessionId, session.id))
        if (hostId)
          await tx.update(gamePlayers).set({ isHost: true }).where(eq(gamePlayers.id, hostId))
      })
      // Reacquire the row lock *after* SQL COMMIT. This transaction never
      // changes ownership in SQL, so a failed read-only COMMIT cannot undo
      // the committed source used by this atomic live publication.
      return await db.transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(gameSessions)
          .where(eq(gameSessions.code, code))
          .for('update')
        if (!session) return null
        await redis.eval(
          `
          if not redis.call('HGET', KEYS[1], 'status') then return 0 end
          local changed = redis.call('HGET', KEYS[1], 'hostId') ~= ARGV[1]
          local players = redis.call('HGETALL', KEYS[2])
          for i = 1, #players, 2 do
            local player = cjson.decode(players[i + 1])
            local isHost = players[i] == ARGV[1]
            if player.isHost ~= isHost then
              changed = true
              player.isHost = isHost
              redis.call('HSET', KEYS[2], players[i], cjson.encode(player))
            end
          end
          redis.call('HSET', KEYS[1], 'hostId', ARGV[1])
          redis.call('HDEL', KEYS[1], 'hostSuccessionPending')
          if changed then redis.call('PUBLISH', ARGV[2], ARGV[3]) end
          return 1
          `,
          2,
          KEYS.game(code),
          KEYS.players(code),
          session.hostPlayerId ?? '',
          KEYS.channel(code),
          JSON.stringify({ type: 'host_changed', hostId: session.hostPlayerId }),
        )
        return session.hostPlayerId
      })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

// S2-1: when every human player has dropped, there is no one left to
// resolve or advance the round. Park the session in 'paused' so the
// 6h stale-game sweeper can later abandon it. The 'paused' status also
// prevents round resolution work on a deserted room.
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
  await state.claimPlayerDrop(code, playerId, connection, reason)
  await continuePlayerDrop(code, playerId)
}

const dropTasks = new Map<string, Promise<void>>()

async function continuePlayerDrop(code: string, playerId: string): Promise<void> {
  const key = `${code}:${playerId}`
  const existing = dropTasks.get(key)
  if (existing) return existing
  const task = (async () => {
    const raw = await redis.hget(KEYS.drops(code), playerId)
    if (!raw) return
    const intent = JSON.parse(raw) as {
      reason: 'grace' | 'leave'
      roundId: string
      voidNextRound?: number
      voidReturnedPlayers?: string[]
    }
    try {
      await finishPlayerDrop(code, playerId, intent)
    } catch (error) {
      // The drop was accepted and SQL records the permanent departure before
      // live effects begin. Expiry during a blocked continuation terminates
      // those effects; it must not turn an accepted leave into a server error.
      if (
        !(error instanceof GameCommandError) ||
        error.code !== 'invalid_token' ||
        (await redis.hget(KEYS.game(code), 'status')) !== null
      )
        throw error
    }
    // Do not acknowledge until SQL, ownership and original-round effects finish.
    await redis.hdel(KEYS.drops(code), playerId)
  })()
  dropTasks.set(key, task)
  try {
    await task
  } finally {
    dropTasks.delete(key)
  }
}

async function finishPlayerDrop(
  code: string,
  playerId: string,
  intent: {
    reason: 'grace' | 'leave'
    roundId: string
    voidNextRound?: number
    voidReturnedPlayers?: string[]
  },
): Promise<void> {
  // Preserve participation and scores while recording the terminal departure.
  await db.update(gamePlayers).set({ status: 'dropped' }).where(eq(gamePlayers.id, playerId))
  await touchSessionActivity(code)
  captureServerEvent(await distinctIdFor(code, playerId), 'cab_player_dropped', {
    roomCode: code,
    playerId,
    reason: intent.reason,
  })

  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) return
  // Lobby and ended rooms still need a host to start or reset. Clear stale
  // ownership even when the last human leaves an active room.
  await migrateHost(code)
  if (session.status !== 'active') return

  // No human left to resolve/advance the round → pause (the 6h sweeper
  // abandons it later). Ownership was already migrated or cleared above.
  const players = await state.getAllPlayers(code)
  const activeHumans = players.filter(
    (p) => p.status === 'active' && p.role === 'player' && !p.isRando,
  )
  if (activeHumans.length === 0) {
    await pauseGame(code)
    return
  }

  if (intent.voidNextRound) {
    const [original] = await db
      .select({ id: gameRounds.id })
      .from(gameRounds)
      .where(
        and(eq(gameRounds.id, intent.roundId), eq(gameRounds.matchId, session.currentMatchId!)),
      )
    if (!original) return
    // The atomic void already returned cards and persisted its continuation.
    // Resume even if startRound inserted SQL before the previous process died.
    if ((await state.getCurrentRound(code)) <= intent.voidNextRound) {
      // Recipients are committed with the returned cards. Retry private hand
      // delivery before successor publication, including a lost Lua reply.
      if (Array.isArray(intent.voidReturnedPlayers))
        for (const playerId of intent.voidReturnedPlayers) await publishHandUpdate(code, playerId)
      await startRound(code, intent.voidNextRound)
    }
    return
  }

  // Picking/waiting restarts fairly; a revealed round keeps its answers
  // and resolves by mode. A claimed/completed round is left alone.
  const [roundRow] = await db
    .select()
    .from(gameRounds)
    .where(
      and(eq(gameRounds.sessionId, session.id), eq(gameRounds.matchId, session.currentMatchId!)),
    )
    .orderBy(desc(gameRounds.roundNum))
    .limit(1)
  // A delayed/retried departure belongs only to the round at its claim.
  // In particular it must never void a successor after progression won.
  if (!intent.roundId || roundRow?.id !== intent.roundId || roundRow.czarPlayerId !== playerId)
    return
  if ((await redis.hget(KEYS.round(code), 'roundId')) !== intent.roundId) return
  const phase = await state.getPhase(code)
  if (phase === 'picking' || phase === 'waiting') {
    await voidRound(code, 'czar_dropped', intent.roundId, playerId)
  } else if (
    phase === 'reveal' ||
    phase === 'judging' ||
    phase === 'ranking' ||
    phase === 'eliminating'
  ) {
    await resolveDroppedCzar(code, playerId, roundRow.id, session.config as GameConfig, phase)
  }
}

async function finishClaimedReveal(
  code: string,
  roundId: string,
  submissions: Record<string, Submission>,
): Promise<void> {
  const order = await getSubOrder(code)
  await state.publishRoundReveals(
    code,
    roundId,
    order.map((key, submissionIndex) => ({
      submissionIndex,
      fills: submissions[key]!.fills,
    })),
    true,
  )
}

async function resolveDroppedCzar(
  code: string,
  czarId: string,
  roundId: string,
  config: GameConfig,
  phase: 'reveal' | 'judging' | 'ranking' | 'eliminating',
): Promise<void> {
  const order = await getSubOrder(code)
  if (!order.length) return
  if (config.rules.includes('survival')) {
    if (phase !== 'reveal' && phase !== 'eliminating') return
    const submissions = await state.getSubmissions(code)
    const remaining = shuffle(order.filter((key) => !submissions[key]?.eliminated))
    if (!remaining.length) return
    const winnerKey = remaining.at(-1)!
    for (const key of remaining.slice(0, -1))
      submissions[key] = { ...submissions[key]!, eliminated: true }
    const decision = decideNormalRound({
      winnerKey,
      submissions,
      players: await state.getAllPlayers(code),
    })
    if (!decision) return
    if (
      await claimCompletionIntent(code, roundId, phase, {
        winnerPlayerId: decision.winnerPlayerId,
        submissionId: publicIdForKey(order, winnerKey),
        submissions,
        czarId,
        adjustments: decision.scoreAdjustments,
        winningFills: decision.winningFills,
        fallbackEliminations: remaining
          .slice(0, -1)
          .map((key) => ({ submissionId: publicIdForKey(order, key), byPlayerId: czarId })),
      })
    )
      await continueRoundCompletion(code)
  } else if (config.rules.includes('serious_business')) {
    if (phase !== 'reveal' && phase !== 'ranking') return
    await resolveRanking(
      code,
      shuffle(order.map((_, index) => String(index))).slice(0, 3),
      roundId,
      phase,
    )
  } else if (!config.rules.includes('godmode')) {
    if (phase !== 'reveal' && phase !== 'judging') return
    await resolvePickedWinner(code, czarId, String(randomInt(0, order.length)), roundId, phase)
  }
}

// ── House rule mechanics ──────────────────────────────────────────

// Gamble submissions are stored under `${playerId}:gamble` in the submissions hash.
function resolvePlayerId(key: string): string {
  return key.endsWith(':gamble') ? key.slice(0, -7) : key
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
    .where(
      and(
        and(eq(gameRounds.sessionId, session.id), eq(gameRounds.matchId, session.currentMatchId!)),
        eq(gameRounds.roundNum, round),
      ),
    )
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
  const { tally, leaders, revote, voteCandidateIds } = result
  await state.publishEvent(code, { type: 'vote_tally', votes: tally })
  if (revote) {
    await state.publishEvent(code, { type: 'vote_tally', votes: {}, voteCandidateIds })
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
  await recordSingleWinnerIntent(
    code,
    roundId,
    winnerKey,
    submissions,
    winnerSubmissionId,
    null,
    tally,
  )
  await continueRoundCompletion(code)
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
    .where(
      and(
        and(eq(gameRounds.sessionId, session.id), eq(gameRounds.matchId, session.currentMatchId!)),
        eq(gameRounds.id, roundId),
      ),
    )
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
  submissions[pid] = { ...submissions[pid]!, eliminated: true }
  await state.publishEvent(code, { type: 'card_eliminated', submissionId, byPlayerId })
  if (winnerKey) {
    const winnerPlayerId = resolvePlayerId(winnerKey)
    const winner = await state.getPlayer(code, winnerPlayerId)
    if (!winner) return
    await finishSurvivalOutcome(code, roundId, winnerKey, submissions, order)
  } else if (nextPlayer) {
    await state.publishEvent(code, { type: 'elimination_turn', playerId: nextPlayer.id })
  }
}

async function finishSurvivalOutcome(
  code: string,
  roundId: string,
  winnerKey: string,
  submissions: Record<string, Submission>,
  order: string[],
): Promise<void> {
  await recordSingleWinnerIntent(
    code,
    roundId,
    winnerKey,
    submissions,
    publicIdForKey(order, winnerKey),
    null,
  )
  await continueRoundCompletion(code)
}

export async function applyRanking(code: string, czarId: string, ranking: string[]): Promise<void> {
  const roundId = await authorizeCzarResolution(code, czarId, 'rank')
  await resolveRanking(code, ranking, roundId, 'ranking', true)
}

async function resolveRanking(
  code: string,
  ranking: string[],
  roundId: string,
  phase: 'ranking' | 'reveal',
  renewLifetime = false,
): Promise<void> {
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
    if (!player) throw new Error('ranked player not found')
    if (rankedSubmissions.length === 0) {
      topWinnerId = pid
      topFills = submission.fills
    }
    rankedSubmissions.push({ ...submission, submissionId: sid, rank: (i + 1) as 1 | 2 | 3 })
  }

  if (
    await claimCompletionIntent(
      code,
      roundId,
      phase,
      {
        winnerPlayerId: topWinnerId!,
        submissionId: ranking[0]!,
        submissions,
        czarId: null,
        adjustments: Object.entries(scoresDelta).map(([playerId, delta]) => ({ playerId, delta })),
        winningFills: topFills,
        ranking: rankedSubmissions,
      },
      renewLifetime,
    )
  )
    await continueRoundCompletion(code)
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
    .select({ id: gameSessions.id, currentMatchId: gameSessions.currentMatchId })
    .from(gameSessions)
    .where(eq(gameSessions.code, code))
  if (!session) return
  const [latestRound] = await db
    .select({ czarPlayerId: gameRounds.czarPlayerId })
    .from(gameRounds)
    .where(
      and(eq(gameRounds.sessionId, session.id), eq(gameRounds.matchId, session.currentMatchId!)),
    )
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
    .where(
      and(
        and(eq(gameRounds.sessionId, session.id), eq(gameRounds.matchId, session.currentMatchId!)),
        eq(gameRounds.roundNum, round),
      ),
    )
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
    await redis.eval(
      `${ROOM_LIFETIME_LUA}
      local round = redis.call('HGET', KEYS[1], 'roundId')
      if not round or redis.call('HGET', KEYS[2], 'packingHeat:' .. ARGV[1]) == round then return end
      local card = redis.call('LPOP', KEYS[3])
      if card then redis.call('RPUSH', KEYS[4], card) end
      redis.call('HSET', KEYS[2], 'packingHeat:' .. ARGV[1], round)
      expireRoomKey(KEYS[4])
    `,
      4,
      KEYS.round(code),
      KEYS.game(code),
      KEYS.deckWhite(code),
      KEYS.hand(code, pid),
      pid,
      ROOM_TTL_SECONDS,
    )
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
  await state.updateLiveRoom(code, { happyEndingArmed: '1' }, playerId, [], undefined, true)
  engineLogger.info({ code, playerId }, 'happy ending armed')
  captureServerEvent(await distinctIdFor(code, playerId), 'cab_rule_triggered', {
    roomCode: code,
    playerId,
    rule: 'happy_ending',
  })
}

// Repeated reconciliation also retries transient backing-store failures and
// covers leases which were valid at boot but expire after the process died.
export async function restoreDisconnectDeadlines(): Promise<void> {
  const failures: unknown[] = []
  let cursor = '0'
  do {
    const result = await redis.scan(cursor, 'MATCH', 'game:*:players', 'COUNT', 100)
    cursor = result[0]
    for (const key of result[1]) {
      const code = key.split(':')[1]!
      try {
        for (const playerId of await redis.hkeys(KEYS.drops(code)))
          await continuePlayerDrop(code, playerId)
        for (const playerId of await redis.hkeys(key)) {
          const generation = await state.reconcileDisconnect(code, playerId)
          if (generation) await dropPlayer(code, playerId, 'grace', generation)
        }
      } catch (err) {
        failures.push(err)
        engineLogger.warn({ err, code }, 'disconnect recovery remains pending')
      }
    }
  } while (cursor !== '0')
  if (failures.length) throw new AggregateError(failures, 'Disconnect recovery incomplete')
}
