import { getRedis } from "./redis";

const TTL_SECONDS = 86400; // 24h

export interface GameConfig {
  totalRounds: number;
  maxPlayers: number;
  packIds: number[];
  houseRules: {
    randoCardrissian: boolean;
    happyEnding: boolean;
    packingHeat: boolean;
  };
}

export interface GamePlayer {
  name: string;
  userId?: string;
  score: number;
  isHost: boolean;
  isSpectator: boolean;
  isPending: boolean;
}

export async function createGameState(
  roomCode: string,
  config: GameConfig,
  hostPlayer: { playerId: string; name: string; userId?: string }
): Promise<void> {
  const redis = getRedis();
  const key = `game:${roomCode}`;

  await redis
    .multi()
    .hset(key, {
      status: "waiting",
      currentRound: "0",
      totalRounds: String(config.totalRounds),
      czarIndex: "0",
      config: JSON.stringify(config),
    })
    .expire(key, TTL_SECONDS)
    .hset(`game:${roomCode}:players`, hostPlayer.playerId, JSON.stringify({
      name: hostPlayer.name,
      userId: hostPlayer.userId,
      score: 0,
      isHost: true,
      isSpectator: false,
      isPending: false,
    }))
    .expire(`game:${roomCode}:players`, TTL_SECONDS)
    .exec();
}

export async function getGameStatus(roomCode: string): Promise<string | null> {
  const redis = getRedis();
  return redis.hget(`game:${roomCode}`, "status");
}

export async function addPlayerToGame(
  roomCode: string,
  playerId: string,
  player: GamePlayer
): Promise<void> {
  const redis = getRedis();
  await redis
    .multi()
    .hset(`game:${roomCode}:players`, playerId, JSON.stringify(player))
    .expire(`game:${roomCode}:players`, TTL_SECONDS)
    .exec();
}

export async function getGamePlayers(
  roomCode: string
): Promise<Record<string, GamePlayer>> {
  const redis = getRedis();
  const raw = await redis.hgetall(`game:${roomCode}:players`);
  const result: Record<string, GamePlayer> = {};
  for (const [id, json] of Object.entries(raw ?? {})) {
    result[id] = JSON.parse(json);
  }
  return result;
}

export async function removePlayerFromGame(
  roomCode: string,
  playerId: string
): Promise<void> {
  const redis = getRedis();
  await redis.hdel(`game:${roomCode}:players`, playerId);
}

export async function publishEvent(
  roomCode: string,
  event: string,
  payload: unknown
): Promise<void> {
  const redis = getRedis();
  await redis.publish(
    `game:${roomCode}:channel`,
    JSON.stringify({ event, payload })
  );
}

export async function getFullGameState(roomCode: string) {
  const redis = getRedis();
  const [meta, roundRaw] = await Promise.all([
    redis.hgetall(`game:${roomCode}`),
    redis.hgetall(`game:${roomCode}:round`),
  ]);
  const players = await getGamePlayers(roomCode);
  return { meta, round: roundRaw, players };
}
