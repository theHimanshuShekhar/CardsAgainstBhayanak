import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRedis } from "../../src/lib/redis";
import { createGameState } from "../../src/lib/game-state";
import { loadDecksIntoRedis, dealHands, submitCards } from "../../src/lib/game-engine";

const ROOM = "ENGTST";
const CONFIG = {
  totalRounds: 3,
  maxPlayers: 4,
  packIds: [1],
  houseRules: { randoCardrissian: false, happyEnding: false, packingHeat: false },
};

async function cleanup() {
  const redis = getRedis();
  const keys = await redis.keys(`game:${ROOM}*`);
  if (keys.length) await redis.del(...keys);
}

beforeEach(async () => {
  await cleanup();
  await createGameState(ROOM, CONFIG, { playerId: "host", name: "Host" });
  await loadDecksIntoRedis(ROOM, CONFIG);
});
afterEach(cleanup);

describe("game engine", () => {
  it("loads decks into Redis with cards", async () => {
    const redis = getRedis();
    const blackCount = await redis.llen(`game:${ROOM}:deck:black`);
    const whiteCount = await redis.llen(`game:${ROOM}:deck:white`);
    expect(blackCount).toBeGreaterThan(0);
    expect(whiteCount).toBeGreaterThan(0);
  });

  it("deals 7 white cards to each non-spectator player", async () => {
    const redis = getRedis();
    await redis.hset(
      `game:${ROOM}:players`,
      "p2",
      JSON.stringify({ name: "Alice", score: 0, isHost: false, isSpectator: false, isPending: false })
    );

    await dealHands(ROOM);

    const hostHand = await redis.scard(`game:${ROOM}:hand:host`);
    const p2Hand = await redis.scard(`game:${ROOM}:hand:p2`);
    expect(hostHand).toBe(7);
    expect(p2Hand).toBe(7);
  });

  it("records a card submission and removes card from hand", async () => {
    const redis = getRedis();
    await redis.sadd(`game:${ROOM}:hand:host`, "100", "101", "102");
    await redis.hset(`game:${ROOM}:round`, "submissions", JSON.stringify({}));
    await redis.hset(`game:${ROOM}:round`, "czarId", "czar_player");

    await submitCards(ROOM, "host", ["100"]);

    const handSize = await redis.scard(`game:${ROOM}:hand:host`);
    expect(handSize).toBe(2);

    const subRaw = await redis.hget(`game:${ROOM}:round`, "submissions");
    const subs = JSON.parse(subRaw ?? "{}");
    expect(subs["host"]).toEqual(["100"]);
  });

  it("throws if card not in hand", async () => {
    const redis = getRedis();
    await redis.sadd(`game:${ROOM}:hand:host`, "100");
    await redis.hset(`game:${ROOM}:round`, "submissions", JSON.stringify({}));

    await expect(submitCards(ROOM, "host", ["999"])).rejects.toThrow(
      "Card 999 not in hand"
    );
  });
});
