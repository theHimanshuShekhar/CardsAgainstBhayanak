import { describe, it, expect, afterEach } from "vitest";
import { getRedis } from "../../src/lib/redis";
import { createGameState } from "../../src/lib/game-state";
import { loadDecksIntoRedis } from "../../src/lib/game-engine";
import { ensureRandoInGame, playRandoCard, RANDO_ID } from "../../src/lib/rando";

const ROOM = "RNDTST";
const CONFIG = {
  totalRounds: 5,
  maxPlayers: 6,
  packIds: [1],
  houseRules: { randoCardrissian: true, happyEnding: false, packingHeat: false },
};

afterEach(async () => {
  const redis = getRedis();
  const keys = await redis.keys(`game:${ROOM}*`);
  if (keys.length) await redis.del(...keys);
});

describe("Rando Cardrissian", () => {
  it("is added to the game with a hand of 7 cards", async () => {
    await createGameState(ROOM, CONFIG, { playerId: "host", name: "Host" });
    await loadDecksIntoRedis(ROOM, CONFIG);
    await ensureRandoInGame(ROOM);

    const redis = getRedis();
    const handSize = await redis.scard(`game:${ROOM}:hand:${RANDO_ID}`);
    expect(handSize).toBe(7);
  });

  it("plays a card from its hand", async () => {
    await createGameState(ROOM, CONFIG, { playerId: "host", name: "Host" });
    await loadDecksIntoRedis(ROOM, CONFIG);
    await ensureRandoInGame(ROOM);

    const redis = getRedis();
    await redis.hset(`game:${ROOM}:round`, "submissions", JSON.stringify({}));

    await playRandoCard(ROOM, 1);

    const subRaw = await redis.hget(`game:${ROOM}:round`, "submissions");
    const subs = JSON.parse(subRaw ?? "{}");
    expect(subs[RANDO_ID]).toHaveLength(1);

    const handSize = await redis.scard(`game:${ROOM}:hand:${RANDO_ID}`);
    expect(handSize).toBe(6);
  });
});
