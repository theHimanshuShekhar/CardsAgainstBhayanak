import { describe, it, expect, afterEach } from "vitest";
import {
  createGameState,
  getGameStatus,
  addPlayerToGame,
  getGamePlayers,
  removePlayerFromGame,
} from "./game-state";
import { getRedis } from "./redis";

const TEST_ROOM = "TSTEST";

afterEach(async () => {
  const redis = getRedis();
  await redis.del(`game:${TEST_ROOM}`, `game:${TEST_ROOM}:players`);
});

describe("game-state Redis helpers", () => {
  it("creates game state with host player", async () => {
    await createGameState(
      TEST_ROOM,
      {
        totalRounds: 8,
        maxPlayers: 10,
        packIds: [1, 2],
        houseRules: { randoCardrissian: false, happyEnding: false, packingHeat: false },
      },
      { playerId: "p1", name: "Alice" }
    );

    const status = await getGameStatus(TEST_ROOM);
    expect(status).toBe("waiting");

    const players = await getGamePlayers(TEST_ROOM);
    expect(players["p1"].name).toBe("Alice");
    expect(players["p1"].isHost).toBe(true);
  });

  it("adds and removes a player", async () => {
    await createGameState(
      TEST_ROOM,
      { totalRounds: 5, maxPlayers: 6, packIds: [], houseRules: { randoCardrissian: false, happyEnding: false, packingHeat: false } },
      { playerId: "host", name: "Host" }
    );

    await addPlayerToGame(TEST_ROOM, "p2", {
      name: "Bob",
      score: 0,
      isHost: false,
      isSpectator: false,
      isPending: false,
    });

    const before = await getGamePlayers(TEST_ROOM);
    expect(Object.keys(before)).toHaveLength(2);

    await removePlayerFromGame(TEST_ROOM, "p2");
    const after = await getGamePlayers(TEST_ROOM);
    expect(Object.keys(after)).toHaveLength(1);
  });
});
