import { loadDecksIntoRedis, startRound } from "./game-engine";
import { ensureRandoInGame } from "./rando";
import { getRedis } from "./redis";

export async function handleGameStarted(roomCode: string): Promise<void> {
  const redis = getRedis();
  const configRaw = await redis.hget(`game:${roomCode}`, "config");
  const config = JSON.parse(configRaw ?? "{}");

  await loadDecksIntoRedis(roomCode, config);

  if (config.houseRules?.randoCardrissian) {
    await ensureRandoInGame(roomCode);
  }

  await startRound(roomCode);
}
