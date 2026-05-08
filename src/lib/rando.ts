import { getRedis } from "./redis";
import { publishEvent } from "./game-state";

export const RANDO_ID = "rando_cardrissian";

export async function ensureRandoInGame(roomCode: string): Promise<void> {
  const redis = getRedis();
  const existing = await redis.hget(`game:${roomCode}:players`, RANDO_ID);
  if (existing) return;

  await redis.hset(
    `game:${roomCode}:players`,
    RANDO_ID,
    JSON.stringify({
      name: "Rando Cardrissian",
      score: 0,
      isHost: false,
      isSpectator: false,
      isPending: false,
    })
  );

  const cards = await redis.lrange(`game:${roomCode}:deck:white`, 0, 6);
  await redis.ltrim(`game:${roomCode}:deck:white`, 7, -1);
  if (cards.length > 0) {
    await redis.sadd(`game:${roomCode}:hand:${RANDO_ID}`, ...cards);
  }

  await publishEvent(roomCode, "player:joined", {
    playerId: RANDO_ID,
    name: "Rando Cardrissian",
    isSpectator: false,
  });
}

export async function playRandoCard(roomCode: string, pick: number): Promise<void> {
  const redis = getRedis();
  const handKey = `game:${roomCode}:hand:${RANDO_ID}`;
  const hand = await redis.smembers(handKey);
  if (hand.length === 0) return;

  const shuffled = [...hand].sort(() => Math.random() - 0.5);
  const chosen = shuffled.slice(0, pick);

  await redis.srem(handKey, ...chosen);

  await redis.hset(`game:${roomCode}:round`, `sub:${RANDO_ID}`, JSON.stringify(chosen));

  await publishEvent(roomCode, "card:played", { playerId: RANDO_ID });
}
