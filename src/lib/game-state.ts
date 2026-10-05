import { redis, KEYS, ROOM_TTL_SECONDS } from './redis'
import { GameCommandError } from './game-command-error'
import type { GameConfig, GamePlayer, GamePhase, Submission } from './types'

export async function createGameState(
  code: string,
  hostId: string,
  config: GameConfig,
): Promise<void> {
  const pipeline = redis.multi()
  pipeline.hset(KEYS.game(code), {
    status: 'lobby',
    currentRound: '0',
    czarIndex: '-1',
    hostId,
    config: JSON.stringify(config),
    lastActivityAt: String(Date.now()),
  })
  pipeline.expire(KEYS.game(code), ROOM_TTL_SECONDS)
  await pipeline.exec()
}

export async function addPlayer(code: string, player: GamePlayer): Promise<void> {
  const pipeline = redis.multi()
  pipeline.hset(KEYS.players(code), player.id, JSON.stringify(player))
  pipeline.expire(KEYS.players(code), ROOM_TTL_SECONDS)
  await pipeline.exec()
}

export async function getPlayer(code: string, playerId: string): Promise<GamePlayer | null> {
  const raw = await redis.hget(KEYS.players(code), playerId)
  return raw ? (JSON.parse(raw) as GamePlayer) : null
}

// S2-11: the read-modify-write must be atomic. A JS get → spread → hset
// races concurrent callers (the grace-timeout drop vs. an engine score
// update, or endRound clearing hasGambled for many players) and loses
// writes via last-writer-wins on the whole JSON blob. Do the field merge
// inside a Lua script so Redis (single-threaded) applies every patch
// against the latest committed value.
const UPDATE_PLAYER_LUA = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then return 0 end
local obj = cjson.decode(cur)
local patch = cjson.decode(ARGV[2])
for k, v in pairs(patch) do obj[k] = v end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(obj))
return 1
`

export async function updatePlayer(
  code: string,
  playerId: string,
  patch: Partial<GamePlayer>,
): Promise<void> {
  await redis.eval(UPDATE_PLAYER_LUA, 1, KEYS.players(code), playerId, JSON.stringify(patch))
}

// Eligibility, wager ownership, and extra-card delivery share the submission
// commit's Redis boundary. A concurrent play sees either the whole wager or
// none of it, and cannot have consumed cards restored by a hand replacement.
const CLAIM_GAMBLE_LUA = `
local storedRoundId = redis.call('HGET', KEYS[3], 'roundId')
if redis.call('HGET', KEYS[2], 'status') ~= 'active'
  or redis.call('HGET', KEYS[2], 'currentRound') ~= ARGV[3]
  or tonumber(ARGV[3]) < 2
  or (storedRoundId and storedRoundId ~= ARGV[2])
  or redis.call('HGET', KEYS[3], 'phase') ~= 'picking'
  or redis.call('EXISTS', KEYS[8]) == 1 then return 'phase' end
local expiresAt = tonumber(redis.call('HGET', KEYS[3], 'roundTimerExpiresAt'))
if expiresAt then
  local now = redis.call('TIME')
  if tonumber(now[1]) * 1000 + tonumber(now[2]) / 1000 >= expiresAt then return 'phase' end
end
local config = cjson.decode(redis.call('HGET', KEYS[2], 'config') or '{}')
for _, rule in ipairs(config.rules or {}) do
  if rule == 'godmode' or rule == 'survival' or rule == 'serious_business' then return 'mode' end
end
local obj = cjson.decode(redis.call('HGET', KEYS[1], ARGV[1]) or '{}')
if obj.role == 'spectator' then return 'spectator' end
local czarId = redis.call('HGET', KEYS[3], 'czarId') or ARGV[4]
if obj.role ~= 'player' or obj.status ~= 'active' or obj.isRando
  or ARGV[1] == czarId
  or redis.call('SISMEMBER', KEYS[7], ARGV[1]) == 1 then return 'actor' end
if obj.hasGambled then return 'duplicate' end
if redis.call('HEXISTS', KEYS[4], ARGV[1]) == 1
  or redis.call('HEXISTS', KEYS[4], ARGV[1] .. ':gamble') == 1 then return 'submitted' end
if (obj.score or 0) < 1 then return 'score' end
local pick = tonumber(ARGV[5])
if redis.call('LLEN', KEYS[5]) < pick then return 'deck' end
obj.hasGambled = true
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(obj))
for i = 1, pick do
  redis.call('RPUSH', KEYS[6], redis.call('LPOP', KEYS[5]))
end
redis.call('HSETNX', KEYS[3], 'roundId', ARGV[2])
redis.call('HSETNX', KEYS[3], 'czarId', ARGV[4])
for i = 1, 3 do redis.call('EXPIRE', KEYS[i], ARGV[6]) end
redis.call('EXPIRE', KEYS[5], ARGV[6])
redis.call('EXPIRE', KEYS[6], ARGV[6])
return 1
`

export async function claimGamble(
  code: string,
  playerId: string,
  roundId: string,
  round: number,
  czarId: string | null,
  pick: number,
): Promise<void> {
  const result = await redis.eval(
    CLAIM_GAMBLE_LUA,
    8,
    KEYS.players(code),
    KEYS.game(code),
    KEYS.round(code),
    submissionsKey(code),
    KEYS.deckWhite(code),
    KEYS.hand(code, playerId),
    skippedKey(code),
    `${KEYS.round(code)}:resolving`,
    playerId,
    roundId,
    round,
    czarId ?? '',
    pick,
    ROOM_TTL_SECONDS,
  )
  if (result === 'spectator')
    throw new GameCommandError('spectator_action', 'Spectators cannot wager')
  if (result === 'actor')
    throw new GameCommandError('not_authorized', 'You cannot wager in this round')
  if (result === 'score')
    throw new GameCommandError('score_too_low', 'You need an Awesome Point to wager')
  if (result === 'mode')
    throw new GameCommandError('invalid_state', 'Gambling requires normal mode')
  if (result === 'duplicate')
    throw new GameCommandError('invalid_state', 'You already wagered this round')
  if (result === 'submitted')
    throw new GameCommandError('invalid_state', 'Wager before submitting cards')
  if (result !== 1)
    throw new GameCommandError('invalid_state', 'This round is not accepting wagers')
}

export async function getAllPlayers(code: string): Promise<GamePlayer[]> {
  const map = await redis.hgetall(KEYS.players(code))
  return Object.values(map).map((s) => JSON.parse(s) as GamePlayer)
}

export async function setCzarOrder(code: string, order: string[]): Promise<void> {
  await redis.del(KEYS.czarOrder(code))
  if (order.length > 0) await redis.rpush(KEYS.czarOrder(code), ...order)
  await redis.expire(KEYS.czarOrder(code), ROOM_TTL_SECONDS)
}

export async function getCzarOrder(code: string): Promise<string[]> {
  return await redis.lrange(KEYS.czarOrder(code), 0, -1)
}

// Mid-game joiners are appended at activation so the stable rotation
// keeps its existing offsets (never recompute from live arrays).
export async function appendCzarOrder(code: string, playerId: string): Promise<void> {
  await redis.rpush(KEYS.czarOrder(code), playerId)
  await redis.expire(KEYS.czarOrder(code), ROOM_TTL_SECONDS)
}

export async function pushDeck(
  code: string,
  kind: 'black' | 'white',
  ids: string[],
): Promise<void> {
  const key = kind === 'black' ? KEYS.deckBlack(code) : KEYS.deckWhite(code)
  await redis.del(key)
  if (ids.length > 0) await redis.rpush(key, ...ids)
  await redis.expire(key, ROOM_TTL_SECONDS)
}

export async function reshuffleWhiteIfLow(code: string, minCards: number): Promise<void> {
  const deckSize = await redis.llen(KEYS.deckWhite(code))
  if (deckSize >= minCards) return
  const discarded = await redis.lrange(KEYS.discardWhite(code), 0, -1)
  if (discarded.length === 0) return
  // Shuffle discarded cards back into the white deck
  const { shuffle } = await import('./rng')
  const reshuffled = shuffle(discarded)
  await redis.del(KEYS.discardWhite(code))
  await redis.rpush(KEYS.deckWhite(code), ...reshuffled)
  await redis.expire(KEYS.deckWhite(code), ROOM_TTL_SECONDS)
}

export async function drawCards(
  code: string,
  kind: 'black' | 'white',
  n: number,
): Promise<string[]> {
  const key = kind === 'black' ? KEYS.deckBlack(code) : KEYS.deckWhite(code)
  const drawn: string[] = []
  for (let i = 0; i < n; i++) {
    const v = await redis.lpop(key)
    if (v) drawn.push(v)
    else break
  }
  return drawn
}

export async function discardCards(
  code: string,
  kind: 'black' | 'white',
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  const key = kind === 'black' ? KEYS.discardBlack(code) : KEYS.discardWhite(code)
  await redis.rpush(key, ...ids)
  await redis.expire(key, ROOM_TTL_SECONDS)
}

// The hand is an ordered Redis list (not a set): a set's SMEMBERS returns
// members in arbitrary order, so every refill / state_snapshot reshuffled
// the player's hand on each round. A list keeps surviving cards in place
// and appends refilled cards to the tail. Card IDs are unique per hand,
// so LREM count 0 is safe.
export async function setHand(code: string, playerId: string, cardIds: string[]): Promise<void> {
  await redis.del(KEYS.hand(code, playerId))
  if (cardIds.length > 0) await redis.rpush(KEYS.hand(code, playerId), ...cardIds)
  await redis.expire(KEYS.hand(code, playerId), ROOM_TTL_SECONDS)
}

export async function getHand(code: string, playerId: string): Promise<string[]> {
  return await redis.lrange(KEYS.hand(code, playerId), 0, -1)
}

export async function removeFromHand(
  code: string,
  playerId: string,
  cardIds: string[],
): Promise<void> {
  for (const id of cardIds) {
    await redis.lrem(KEYS.hand(code, playerId), 0, id)
  }
}

const submissionsKey = (code: string) => `${KEYS.round(code)}:submissions`

// Ownership is checked against the live hand at the same instant the
// submission is recorded and its cards are consumed.
const COMMIT_SUBMISSION_LUA = `
local storedRoundId = redis.call('HGET', KEYS[4], 'roundId')
local legacyRound = not storedRoundId
  and redis.call('HGET', KEYS[5], 'currentRound') == ARGV[6]
local status = redis.call('HGET', KEYS[5], 'status')
if redis.call('HGET', KEYS[4], 'phase') ~= 'picking'
  or redis.call('HGET', KEYS[5], 'currentRound') ~= ARGV[6]
  or (storedRoundId ~= ARGV[5] and not legacyRound)
  or (status ~= 'active' and not (legacyRound and status == 'lobby'))
  or redis.call('EXISTS', KEYS[7]) == 1 then return 'phase' end
local expiresAt = tonumber(redis.call('HGET', KEYS[4], 'roundTimerExpiresAt'))
if expiresAt then
  local now = redis.call('TIME')
  if tonumber(now[1]) * 1000 + tonumber(now[2]) / 1000 >= expiresAt then return 'phase' end
end
local player = cjson.decode(redis.call('HGET', KEYS[3], ARGV[1]) or '{}')
if player.role == 'spectator' then return 'spectator' end
local czarId = redis.call('HGET', KEYS[4], 'czarId') or ARGV[7]
if player.role ~= 'player' or player.status ~= 'active' or player.isRando
  or ARGV[1] == czarId
  or redis.call('SISMEMBER', KEYS[6], ARGV[1]) == 1 then return 'actor' end
local submission = cjson.decode(ARGV[2])
if #submission.fills ~= tonumber(ARGV[4]) then return 'cards' end
local distinct = {}
for _, card in ipairs(submission.fills) do
  if distinct[card.id] then return 'cards' end
  distinct[card.id] = true
end
local hand = redis.call('LRANGE', KEYS[2], 0, -1)
local owned = {}
for _, id in ipairs(hand) do owned[id] = true end
for _, card in ipairs(submission.fills) do
  if not owned[card.id] then return 'cards' end
end
local slot = ARGV[1]
if player.hasGambled and redis.call('HEXISTS', KEYS[1], slot) == 1 then
  slot = slot .. ':gamble'
end
if redis.call('HEXISTS', KEYS[1], slot) == 1 then return 'submitted' end
-- Rooms already picking before this deployment lack the new identity.
-- Upgrade only the DB-verified current round, inside the same commit.
if legacyRound then
  redis.call('HSET', KEYS[4], 'roundId', ARGV[5], 'czarId', czarId)
  redis.call('HSET', KEYS[5], 'status', 'active')
  redis.call('EXPIRE', KEYS[4], ARGV[3])
  redis.call('EXPIRE', KEYS[5], ARGV[3])
end
redis.call('HSET', KEYS[1], slot, ARGV[2])
for _, card in ipairs(submission.fills) do
  redis.call('LREM', KEYS[2], 0, card.id)
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`

export async function commitSubmission(
  code: string,
  playerId: string,
  submission: Submission,
  pick: number,
  roundId: string,
  round: number,
  czarId: string | null,
): Promise<void> {
  const accepted = await redis.eval(
    COMMIT_SUBMISSION_LUA,
    7,
    submissionsKey(code),
    KEYS.hand(code, playerId),
    KEYS.players(code),
    KEYS.round(code),
    KEYS.game(code),
    skippedKey(code),
    `${KEYS.round(code)}:resolving`,
    playerId,
    JSON.stringify(submission),
    ROOM_TTL_SECONDS,
    pick,
    roundId,
    round,
    czarId ?? '',
  )
  if (accepted === 'spectator')
    throw new GameCommandError('spectator_action', 'Spectators cannot submit cards')
  if (accepted === 'actor')
    throw new GameCommandError('not_authorized', 'You cannot submit in this round')
  if (accepted === 'phase')
    throw new GameCommandError('invalid_state', 'This round is not accepting submissions')
  if (accepted === 'submitted')
    throw new GameCommandError('invalid_state', 'Your submissions are already complete')
  if (accepted !== 1)
    throw new GameCommandError('invalid_state', 'Submit the required distinct cards from your hand')
}

export async function setSubmission(
  code: string,
  playerId: string,
  submission: Submission,
): Promise<void> {
  await redis.hset(submissionsKey(code), playerId, JSON.stringify(submission))
  await redis.expire(submissionsKey(code), ROOM_TTL_SECONDS)
}

export async function getSubmissions(code: string): Promise<Record<string, Submission>> {
  const raw = await redis.hgetall(submissionsKey(code))
  const out: Record<string, Submission> = {}
  for (const [pid, json] of Object.entries(raw)) out[pid] = JSON.parse(json) as Submission
  return out
}

export async function clearSubmissions(code: string): Promise<void> {
  await redis.del(submissionsKey(code))
}

export async function publishEvent(code: string, event: unknown): Promise<void> {
  await redis.publish(KEYS.channel(code), JSON.stringify(event))
}

export async function setGrace(code: string, playerId: string, ms: number): Promise<void> {
  await redis.set(KEYS.grace(code, playerId), '1', 'PX', ms)
}

export async function clearGrace(code: string, playerId: string): Promise<void> {
  await redis.del(KEYS.grace(code, playerId))
}

export async function setCurrentRound(code: string, round: number): Promise<void> {
  await redis.hset(KEYS.game(code), 'currentRound', String(round))
}

export async function getCurrentRound(code: string): Promise<number> {
  const val = await redis.hget(KEYS.game(code), 'currentRound')
  return val ? Number(val) : 0
}

// Upgrade active rooms created before round identity was persisted. A
// recovery read must never stamp an older DB row over a newer round.
export async function ensureRoundIdentity(
  code: string,
  round: number,
  roundId: string,
  czarId: string | null,
): Promise<boolean> {
  const ok = await redis.eval(
    `
    if redis.call('HGET', KEYS[1], 'currentRound') ~= ARGV[1] then return 0 end
    local current = redis.call('HGET', KEYS[2], 'roundId')
    if current and current ~= ARGV[2] then return 0 end
    redis.call('HSETNX', KEYS[2], 'roundId', ARGV[2])
    redis.call('HSETNX', KEYS[2], 'czarId', ARGV[3])
    redis.call('EXPIRE', KEYS[2], ARGV[4])
    if not current and redis.call('HGET', KEYS[1], 'status') == 'lobby' then
      redis.call('HSET', KEYS[1], 'status', 'active')
      redis.call('EXPIRE', KEYS[1], ARGV[4])
    end
    return 1
    `,
    2,
    KEYS.game(code),
    KEYS.round(code),
    round,
    roundId,
    czarId ?? '',
    ROOM_TTL_SECONDS,
  )
  return ok === 1
}

export async function setRoundTimerExpiresAt(code: string, expiresAt: number): Promise<void> {
  await redis.hset(KEYS.round(code), 'roundTimerExpiresAt', String(expiresAt))
  await redis.expire(KEYS.round(code), ROOM_TTL_SECONDS)
}

// S2-10: read back the persisted expiry so a server restart can re-arm
// the (process-local) round timer instead of leaving the round timerless.
export async function getRoundTimerExpiresAt(code: string): Promise<number | null> {
  const val = await redis.hget(KEYS.round(code), 'roundTimerExpiresAt')
  return val ? Number(val) : null
}

// S2-NEW: the post-resolve ROUND_RESULT_PAUSE_MS hold (the 4s beat that
// lets clients read the round_won badge before the next round_started)
// was a process-local `await sleep(...)`. A restart in that window left
// the round in phase='transition' forever with no one to advance it.
// Persist the absolute resume-at timestamp so the boot path can schedule
// the finalize step that endRound would have run.
export async function setPostResolveResumeAt(code: string, ts: number): Promise<void> {
  await redis.hset(KEYS.round(code), 'postResolveResumeAt', String(ts))
  await redis.expire(KEYS.round(code), ROOM_TTL_SECONDS)
}

export async function getPostResolveResumeAt(code: string): Promise<number | null> {
  const val = await redis.hget(KEYS.round(code), 'postResolveResumeAt')
  return val ? Number(val) : null
}

export async function clearPostResolveResumeAt(code: string): Promise<void> {
  await redis.hdel(KEYS.round(code), 'postResolveResumeAt')
}

// Atomic read-and-clear of the postResolveResumeAt cursor. The naive
// `getPostResolveResumeAt` + `clearPostResolveResumeAt` pair is not safe
// as an idempotency guard: two callers (e.g. the in-process endRound
// continuation racing a boot-restore scheduler, or two boot-restore
// passes in a process restart loop) can both pass the non-null read
// before either gets to clear. The result is `startRound(nextRound)`
// called twice — the second call overwrites the round hash with a
// fresh black card while the gameRounds DB row still holds the first
// call's pick, which shows up as a `pick`/hand-count mismatch in the
// Gambling spec. Doing the read+delete inside a single Lua script
// guarantees exactly one caller sees the prior value; the other gets
// nil and bails.
const TAKE_RESUME_AT_LUA = `
local v = redis.call('HGET', KEYS[1], 'postResolveResumeAt')
if not v then return nil end
redis.call('HDEL', KEYS[1], 'postResolveResumeAt')
return v
`

export async function takePostResolveResumeAt(code: string): Promise<number | null> {
  const v = await redis.eval(TAKE_RESUME_AT_LUA, 1, KEYS.round(code))
  return v ? Number(v) : null
}

// S2-1: persist the authoritative phase so a disconnect handler can tell
// whether a round is mid-flight (and which czar owns it) without having
// to re-derive it the way buildSnapshot does.
export async function setPhase(code: string, phase: GamePhase): Promise<void> {
  await redis.hset(KEYS.round(code), 'phase', phase)
  await redis.expire(KEYS.round(code), ROOM_TTL_SECONDS)
}

export async function getHostId(code: string): Promise<string | null> {
  const val = await redis.hget(KEYS.game(code), 'hostId')
  return val || null
}

export async function getPhase(code: string): Promise<GamePhase | null> {
  const val = await redis.hget(KEYS.round(code), 'phase')
  return val ? (val as GamePhase) : null
}

// S2-9: persist the round outcome so a reconnect during the post-resolve
// 'transition' window (and the Survival turn / Serious Business ranking)
// can be restored in the snapshot instead of being lost.
export async function setRoundWinner(code: string, winnerId: string): Promise<void> {
  await redis.hset(KEYS.round(code), 'winnerId', winnerId)
  await redis.expire(KEYS.round(code), ROOM_TTL_SECONDS)
}

// Every terminal mode competes for this same generation-bound claim. Checking
// phase and identity in Redis prevents a delayed command from claiming a new
// round after its own round's resolution fields have been cleared.
const CLAIM_ROUND_OUTCOME_LUA = `
if redis.call('HGET', KEYS[1], 'roundId') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'phase') ~= ARGV[2] then return 0 end
if redis.call('HEXISTS', KEYS[1], 'outcomeClaim') == 1 then return 0 end
redis.call('HSET', KEYS[1], 'outcomeClaim', ARGV[1], 'winnerId', ARGV[3], 'phase', 'transition')
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`

export async function claimRoundOutcome(
  code: string,
  roundId: string,
  phase: GamePhase,
  winnerId: string,
): Promise<boolean> {
  return (
    (await redis.eval(
      CLAIM_ROUND_OUTCOME_LUA,
      1,
      KEYS.round(code),
      roundId,
      phase,
      winnerId,
      ROOM_TTL_SECONDS,
    )) === 1
  )
}

const CLAIM_ROUND_COMPLETION_LUA = `
if redis.call('HGET', KEYS[1], 'roundId') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'outcomeClaim') ~= ARGV[1] then return 0 end
local ok = redis.call('HSETNX', KEYS[1], 'completionClaim', ARGV[1])
if ok == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return ok
`

export async function claimRoundCompletion(code: string, roundId: string): Promise<boolean> {
  return (
    (await redis.eval(
      CLAIM_ROUND_COMPLETION_LUA,
      1,
      KEYS.round(code),
      roundId,
      ROOM_TTL_SECONDS,
    )) === 1
  )
}

export async function getRoundWinner(code: string): Promise<string | null> {
  const val = await redis.hget(KEYS.round(code), 'winnerId')
  return val || null
}

export async function setRoundRanking(code: string, ranking: Submission[]): Promise<void> {
  await redis.hset(KEYS.round(code), 'ranking', JSON.stringify(ranking))
  await redis.expire(KEYS.round(code), ROOM_TTL_SECONDS)
}

export async function getRoundRanking(code: string): Promise<Submission[] | null> {
  const val = await redis.hget(KEYS.round(code), 'ranking')
  return val ? (JSON.parse(val) as Submission[]) : null
}

export async function getEliminationTurn(code: string): Promise<string | null> {
  const val = await redis.hget(KEYS.round(code), 'eliminationTurnPlayerId')
  return val || null
}

// Wipe per-round resolution fields so a fresh round's snapshot doesn't
// surface the previous round's winner / ranking / elimination turn.
export async function clearRoundResolution(code: string): Promise<void> {
  await redis.hdel(
    KEYS.round(code),
    'winnerId',
    'ranking',
    'eliminationTurnPlayerId',
    'outcomeClaim',
    'completionClaim',
    'voteEpoch',
    'voteClosed',
  )
}

const skippedKey = (code: string) => `${KEYS.round(code)}:skipped`

export async function addSkippedPlayer(code: string, playerId: string): Promise<void> {
  await redis.sadd(skippedKey(code), playerId)
  await redis.expire(skippedKey(code), ROOM_TTL_SECONDS)
}

export async function getSkippedPlayers(code: string): Promise<string[]> {
  return redis.smembers(skippedKey(code))
}

export async function clearSkippedPlayers(code: string): Promise<void> {
  await redis.del(skippedKey(code))
}

// Turn validation, card removal and turn advancement are one operation.
// A second frame from the old actor cannot remove another submission.
const ELIMINATE_LUA = `
if redis.call('HGET', KEYS[1], 'roundId') ~= ARGV[1] then return nil end
if redis.call('HGET', KEYS[1], 'phase') ~= 'eliminating' then return nil end
if ARGV[2] == '' or redis.call('HGET', KEYS[1], 'eliminationTurnPlayerId') ~= ARGV[2] then return nil end
if redis.call('HGET', KEYS[1], 'czarId') == ARGV[2] then return nil end
local actor = redis.call('HGET', KEYS[3], ARGV[2])
if not actor then return nil end
actor = cjson.decode(actor)
if actor.status ~= 'active' or actor.role ~= 'player' or actor.isRando then return nil end
local raw = redis.call('HGET', KEYS[2], ARGV[3])
if not raw then return nil end
local submission = cjson.decode(raw)
if submission.eliminated then return nil end
submission.eliminated = true
redis.call('HSET', KEYS[2], ARGV[3], cjson.encode(submission))
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[5])
local remaining = {}
local entries = redis.call('HGETALL', KEYS[2])
for i = 1, #entries, 2 do
  if not cjson.decode(entries[i + 1]).eliminated then table.insert(remaining, entries[i]) end
end
if #remaining == 1 then
  redis.call('HSET', KEYS[1], 'eliminationTurnPlayerId', '')
  return remaining[1]
end
redis.call('HSET', KEYS[1], 'eliminationTurnPlayerId', ARGV[4])
return ''
`

export async function commitElimination(
  code: string,
  roundId: string,
  actorId: string,
  submissionKey: string,
  nextActorId: string,
): Promise<string | null> {
  return (await redis.eval(
    ELIMINATE_LUA,
    3,
    KEYS.round(code),
    submissionsKey(code),
    KEYS.players(code),
    roundId,
    actorId,
    submissionKey,
    nextActorId,
    ROOM_TTL_SECONDS,
  )) as string | null
}

// Register a ballot and close its election in one Redis operation. Only
// the last accepted ballot can decide a winner or open the next revote.
const VOTE_LUA = `
if redis.call('HGET', KEYS[1], 'roundId') ~= ARGV[1] then return nil end
if redis.call('HGET', KEYS[1], 'phase') ~= 'waiting' then return nil end
if (redis.call('HGET', KEYS[1], 'voteEpoch') or '0') ~= ARGV[2] then return nil end
if redis.call('HEXISTS', KEYS[1], 'voteClosed') == 1 then return nil end
local actor = redis.call('HGET', KEYS[2], ARGV[3])
if not actor then return nil end
actor = cjson.decode(actor)
if actor.status ~= 'active' or actor.role ~= 'player' or actor.isRando then return nil end
if ARGV[3] == ARGV[5] then return nil end
local submission = redis.call('HGET', KEYS[3], ARGV[5])
if not submission or cjson.decode(submission).eliminated then return nil end
if redis.call('SADD', KEYS[4], ARGV[3]) == 0 then return nil end
redis.call('HSET', KEYS[5], ARGV[3], ARGV[4])
redis.call('HINCRBY', KEYS[6], ARGV[4], 1)
redis.call('EXPIRE', KEYS[1], ARGV[6])
for i = 4, 7 do redis.call('EXPIRE', KEYS[i], ARGV[6]) end
local tally = {}
local total = 0
local max = 0
local entries = redis.call('HGETALL', KEYS[6])
for i = 1, #entries, 2 do
  local n = tonumber(entries[i + 1])
  tally[entries[i]] = n
  total = total + n
  if n > max then max = n end
end
local voters = 0
for _, raw in ipairs(redis.call('HVALS', KEYS[2])) do
  local player = cjson.decode(raw)
  if player.status == 'active' and player.role == 'player' and not player.isRando then voters = voters + 1 end
end
if total < voters then return cjson.encode({tally = tally}) end
local leaders = {}
for sid, n in pairs(tally) do if n == max then table.insert(leaders, sid) end end
local attempts = 0
if #leaders > 1 then
  attempts = redis.call('INCR', KEYS[7])
  redis.call('EXPIRE', KEYS[7], ARGV[6])
end
if #leaders > 1 and attempts <= 2 then
  redis.call('HINCRBY', KEYS[1], 'voteEpoch', 1)
  redis.call('DEL', KEYS[4], KEYS[5], KEYS[6])
  return cjson.encode({tally = tally, revote = true})
end
redis.call('HSET', KEYS[1], 'voteClosed', '1')
return cjson.encode({tally = tally, leaders = leaders})
`

export async function commitVote(
  code: string,
  roundId: string,
  epoch: string,
  voterId: string,
  submissionId: string,
  submissionKey: string,
): Promise<{ tally: Record<string, number>; leaders?: string[]; revote?: boolean } | null> {
  const raw = await redis.eval(
    VOTE_LUA,
    7,
    KEYS.round(code),
    KEYS.players(code),
    submissionsKey(code),
    `${KEYS.round(code)}:voters`,
    `${KEYS.round(code)}:voterchoices`,
    `${KEYS.round(code)}:votetally`,
    `${KEYS.round(code)}:tiebreak`,
    roundId,
    epoch,
    voterId,
    submissionId,
    submissionKey,
    ROOM_TTL_SECONDS,
  )
  return raw ? JSON.parse(raw as string) : null
}
