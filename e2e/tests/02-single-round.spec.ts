import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import {
  createGame,
  joinGame,
  startGame,
  waitForSession,
  findCzar,
  playCard,
  pickWinner,
  getScores,
} from "../fixtures/game";

test.describe("02 — Single Round", () => {
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

  test("czar waits; non-czars play; czar picks; winner score increments", async () => {
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
    const { czarPage, nonCzarPages } = await findCzar(pages);

    // Czar sees black card
    await expect(czarPage.locator('[data-testid="black-card"]')).toBeVisible();

    // Czar has no play button (hand is disabled) but hand is visible
    // Non-czar pages can play
    await Promise.all(nonCzarPages.map((p) => playCard(p)));

    // Czar sees 2 submissions
    await expect(czarPage.locator('[data-testid="submission"]')).toHaveCount(2, {
      timeout: 20_000,
    });

    // Pick winner
    await pickWinner(czarPage);

    // After pick, scores update: one player has 1 point, others 0
    await expect(async () => {
      const scores = await getScores(p1);
      const vals = Object.values(scores);
      expect(vals.some((s) => s === 1)).toBe(true);
      expect(vals.filter((s) => s === 0).length).toBe(vals.length - 1);
    }).toPass({ timeout: 15_000 });

    // Scores are consistent across all pages
    const [s1, s2, s3] = await Promise.all([getScores(p1), getScores(p2), getScores(p3)]);
    const winners1 = Object.values(s1).filter((v) => v === 1).length;
    const winners2 = Object.values(s2).filter((v) => v === 1).length;
    const winners3 = Object.values(s3).filter((v) => v === 1).length;
    expect(winners1).toBe(1);
    expect(winners2).toBe(1);
    expect(winners3).toBe(1);
  });
});
