import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import {
  createGame,
  joinGame,
  startGame,
  waitForSession,
  playRound,
} from "../fixtures/game";

test.describe("04 — End Game", () => {
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

  test("all contexts navigate to /end; end screen shows scores and highlights winner", async () => {
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    const p3 = await ctx3.newPage();

    const ts = Date.now();
    const { roomCode } = await createGame(p1, {
      displayName: `guest_host_${ts}`,
      totalRounds: 2,
    });
    await joinGame(p2, roomCode, `guest_p2_${ts}`);
    await joinGame(p3, roomCode, `guest_p3_${ts}`);

    await expect(p1.locator('[data-testid="player-list-item"]')).toHaveCount(3, {
      timeout: 10_000,
    });

    await startGame(p1);
    await Promise.all([waitForSession(p1), waitForSession(p2), waitForSession(p3)]);

    const pages = [p1, p2, p3];

    // Play all rounds
    for (let i = 0; i < 2; i++) {
      await playRound(pages);
    }

    // All contexts navigate to /end
    for (const page of pages) {
      await page.waitForURL(/\/games\/[A-Z0-9]+\/end/, { timeout: 30_000 });
    }

    // End screen shows final scores for all players
    await expect(p1.locator('[data-testid="final-score-entry"]')).toHaveCount(3, {
      timeout: 10_000,
    });

    // Winner display is present
    await expect(p1.locator('[data-testid="winner-display"]')).toBeVisible();

    // Verify from all three contexts
    for (const page of pages) {
      await expect(page.locator('[data-testid="final-score-entry"]')).toHaveCount(3, {
        timeout: 10_000,
      });
    }
  });
});
