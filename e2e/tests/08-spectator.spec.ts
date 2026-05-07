import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import {
  createGame,
  joinGame,
  startGame,
  waitForSession,
  findCzar,
  playCard,
  pickWinner,
} from "../fixtures/game";

test.describe("08 — Spectator", () => {
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

  test("spectator sees game but has no hand; round proceeds without spectator submission", async () => {
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    const p3 = await ctx3.newPage();
    const spectator = await ctx4.newPage();

    const ts = Date.now();
    const { roomCode } = await createGame(p1, {
      displayName: `guest_host_${ts}`,
      totalRounds: 2,
    });
    await joinGame(p2, roomCode, `guest_p2_${ts}`);
    await joinGame(p3, roomCode, `guest_p3_${ts}`);
    await joinGame(spectator, roomCode, `guest_spec_${ts}`, { spectator: true });

    // Spectator appears in spectator list (not player list)
    await expect(p1.locator('[data-testid="spectator-list-item"]')).toHaveCount(1, {
      timeout: 10_000,
    });

    // Still only 3 active players
    await expect(p1.locator('[data-testid="player-list-item"]')).toHaveCount(3, {
      timeout: 10_000,
    });

    await startGame(p1);
    await Promise.all([
      waitForSession(p1),
      waitForSession(p2),
      waitForSession(p3),
      waitForSession(spectator),
    ]);

    // Spectator sees the black card
    await expect(spectator.locator('[data-testid="black-card"]')).toBeVisible({
      timeout: 15_000,
    });

    // Spectator has no hand
    await expect(spectator.locator('[data-testid="hand-card"]')).toHaveCount(0);

    // Play round with 3 players — spectator does not block
    const { czarPage, nonCzarPages } = await findCzar([p1, p2, p3]);
    await Promise.all(nonCzarPages.map((p) => playCard(p)));
    await pickWinner(czarPage);

    // Round completes — game moves on (spectator still on session or end page)
    const spectatorUrl = spectator.url();
    expect(spectatorUrl).toMatch(/\/games\/[A-Z0-9]+\/(session|end)/);
  });
});
