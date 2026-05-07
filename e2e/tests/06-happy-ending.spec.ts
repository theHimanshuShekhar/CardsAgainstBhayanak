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

test.describe("06 — Happy Ending", () => {
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

  test("happy ending: final round black card is haiku (Pick 3); game ends normally", async () => {
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    const p3 = await ctx3.newPage();

    const ts = Date.now();
    const { roomCode } = await createGame(p1, {
      displayName: `guest_host_${ts}`,
      totalRounds: 2,
      happyEnding: true,
    });
    await joinGame(p2, roomCode, `guest_p2_${ts}`);
    await joinGame(p3, roomCode, `guest_p3_${ts}`);

    await expect(p1.locator('[data-testid="player-list-item"]')).toHaveCount(3, {
      timeout: 10_000,
    });

    await startGame(p1);
    await Promise.all([waitForSession(p1), waitForSession(p2), waitForSession(p3)]);

    const pages = [p1, p2, p3];

    // Round 1 — play normally
    await waitForRound(p1, 1);
    const { czarPage: czar1, nonCzarPages: nonCzar1 } = await findCzar(pages);
    await Promise.all(nonCzar1.map((p) => playCard(p)));
    await pickWinner(czar1);

    // Round 2 (final) — should be the haiku black card (Pick 3)
    await waitForRound(p1, 2);

    // Black card should show "Pick 3"
    await expect(p1.locator('[data-testid="black-card"]')).toContainText("Pick 3", {
      timeout: 15_000,
    });

    // Non-czar players play (UI submits 1 card per click; game engine accepts it)
    const { czarPage: czar2, nonCzarPages: nonCzar2 } = await findCzar(pages);
    await Promise.all(nonCzar2.map((p) => playCard(p)));

    // Czar picks
    await pickWinner(czar2);

    // Game ends normally
    for (const page of pages) {
      await page.waitForURL(/\/games\/[A-Z0-9]+\/end/, { timeout: 30_000 });
    }
    await expect(p1.locator('[data-testid="winner-display"]')).toBeVisible();
  });
});
