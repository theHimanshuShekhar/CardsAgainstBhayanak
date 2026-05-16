import { redis, KEYS, ROOM_TTL_SECONDS } from './redis'
import type { GameConfig, GamePlayer, Submission } from './types'

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

export async function updatePlayer(
  code: string,
  playerId: string,
  patch: Partial<GamePlayer>,
): Promise<void> {
  const existing = await getPlayer(code, playerId)
  if (!existing) return
  const updated = { ...existing, ...patch }
  await redis.hset(KEYS.players(code), playerId, JSON.stringify(updated))
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

export async function setHand(code: string, playerId: string, cardIds: string[]): Promise<void> {
  await redis.del(KEYS.hand(code, playerId))
  if (cardIds.length > 0) await redis.sadd(KEYS.hand(code, playerId), ...cardIds)
  await redis.expire(KEYS.hand(code, playerId), ROOM_TTL_SECONDS)
}

export async function getHand(code: string, playerId: string): Promise<string[]> {
  return await redis.smembers(KEYS.hand(code, playerId))
}

export async function removeFromHand(
  code: string,
  playerId: string,
  cardIds: string[],
): Promise<void> {
  if (cardIds.length > 0) await redis.srem(KEYS.hand(code, playerId), ...cardIds)
}

const submissionsKey = (code: string) => `${KEYS.round(code)}:submissions`

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

export async function setRoundTimerExpiresAt(code: string, expiresAt: number): Promise<void> {
  await redis.hset(KEYS.round(code), 'roundTimerExpiresAt', String(expiresAt))
  await redis.expire(KEYS.round(code), ROOM_TTL_SECONDS)
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
