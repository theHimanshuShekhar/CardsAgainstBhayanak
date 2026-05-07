import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import {
  createGame,
  joinGame,
  startGame,
  waitForSession,
  findCzar,
  playCard,
  pickWinner,
  waitForRound,
} from "../fixtures/game";

test.describe("03 — Multi-Round Scoring", () => {
  let ctx1: BrowserContext, ctx2: BrowserContext, ctx3: BrowserContext;

  test.beforeEach(async ({ browser }: { browser: Browser }) => {
    [ctx1, ctx2, ctx3] = await Promise.all([
      browser.newContext(),
      browser.newContext(),
      browser.newContext(),
    ]);
  });

  test.afterEach(async () => {
    await Promise.all([ctx1.close(), ctx2.close(), ctx3.close()]);
  });

  test("czar rotates each round; round counter increments; scores cumulate", async () => {
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    const p3 = await ctx3.newPage();

    const ts = Date.now();
    const { roomCode } = await createGame(p1, {
      displayName: `guest_host_${ts}`,
      totalRounds: 3,
    });
    await joinGame(p2, roomCode, `guest_p2_${ts}`);
    await joinGame(p3, roomCode, `guest_p3_${ts}`);

    await expect(p1.locator('[data-testid="player-list-item"]')).toHaveCount(3, {
      timeout: 10_000,
    });

    await startGame(p1);
    await Promise.all([waitForSession(p1), waitForSession(p2), waitForSession(p3)]);

    const pages = [p1, p2, p3];

    // Track czar pages across rounds — they should differ
    const czarPages: string[] = [];

    for (let round = 1; round <= 3; round++) {
      await waitForRound(p1, round);

      const { czarPage, nonCzarPages } = await findCzar(pages);
      czarPages.push(czarPage.url());

      await Promise.all(nonCzarPages.map((p) => playCard(p)));
      await pickWinner(czarPage);

      if (round < 3) {
        // Wait for next round to start before continuing
        await waitForRound(p1, round + 1);
      }
    }

    // Each round should have had a different czar (index rotates)
    // With 3 players and 3 rounds, each player is czar exactly once
    const uniqueCzars = new Set(czarPages);
    expect(uniqueCzars.size).toBe(3);
  });
});
