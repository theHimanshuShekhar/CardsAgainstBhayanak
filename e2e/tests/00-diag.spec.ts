import { test, expect } from "@playwright/test";
import { createGame, joinGame } from "../fixtures/game";

test("diagnostic: API-based createGame + joinGame", async ({ browser }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();

  try {
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const ts = Date.now();
    const { roomCode, playerId: hostId } = await createGame(p1, {
      displayName: `host_diag_${ts}`,
      totalRounds: 2,
    });
    console.log("Created game:", roomCode, "host:", hostId);
    console.log("P1 URL:", p1.url());

    await joinGame(p2, roomCode, `p2_diag_${ts}`);
    console.log("P2 joined. P2 URL:", p2.url());

    // Both should be on the lobby page
    expect(p1.url()).toMatch(/\/games\/[A-Z0-9]+\/lobby/);
    expect(p2.url()).toMatch(/\/games\/[A-Z0-9]+\/lobby/);

    // Player list should appear
    await expect(p1.locator('[data-testid="player-list-item"]')).toHaveCount(2, {
      timeout: 10_000,
    });
    console.log("SUCCESS: both players on lobby, player list shows 2");
  } finally {
    await Promise.all([ctx1.close(), ctx2.close()]);
  }
});
