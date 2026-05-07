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
  getHandSize,
} from "../fixtures/game";

test.describe("09 — Mid-Game Join", () => {
  let ctx1: BrowserContext,
    ctx2: BrowserContext,
    ctx3: BrowserContext,
    ctx4: BrowserContext;

  test.beforeEach(async ({ browser }: { browser: Browser }) => {
    [ctx1, ctx2, ctx3, ctx4] = await Promise.all([
      browser.newContext(),
      browser.newContext(),
      browser.newContext(),
      browser.newContext(),
    ]);
  });

  test.afterEach(async () => {
    await Promise.all([ctx1.close(), ctx2.close(), ctx3.close(), ctx4.close()]);
  });

  test("late joiner sees pending state; gets hand in round 2; participates normally", async () => {
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    const p3 = await ctx3.newPage();
    const p4 = await ctx4.newPage();

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

    // p4 joins mid-game
    await joinGame(p4, roomCode, `guest_late_${ts}`);
    await waitForSession(p4);

    // Round 1 plays out with 3 players
    await waitForRound(p1, 1);
    const { czarPage, nonCzarPages } = await findCzar([p1, p2, p3]);

    // p4 should have no hand initially (pending)
    const p4HandRound1 = await getHandSize(p4);
    expect(p4HandRound1).toBe(0);

    await Promise.all(nonCzarPages.map((p) => playCard(p)));
    await pickWinner(czarPage);

    // Round 2 starts — p4 should now receive cards
    await waitForRound(p1, 2);

    // p4 gets cards at round 2 start (7 cards dealt)
    await expect(async () => {
      const size = await getHandSize(p4);
      expect(size).toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });

    // p4 can participate in round 2
    const allPages = [p1, p2, p3, p4];
    const { czarPage: czar2, nonCzarPages: nonCzar2 } = await findCzar(allPages);
    await Promise.all(nonCzar2.map((p) => playCard(p)));
    await pickWinner(czar2);
  });
});
