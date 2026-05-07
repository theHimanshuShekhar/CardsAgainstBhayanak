import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { createGame, joinGame, startGame, waitForSession } from "../fixtures/game";

test.describe("01 — Lobby Flow", () => {
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

  test("players appear in lobby; only host sees Start; Start navigates all to session", async () => {
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    const p3 = await ctx3.newPage();

    const ts = Date.now();
    const hostName = `guest_host_${ts}`;
    const p2Name = `guest_p2_${ts}`;
    const p3Name = `guest_p3_${ts}`;

    const { roomCode } = await createGame(p1, { displayName: hostName, totalRounds: 2 });
    await joinGame(p2, roomCode, p2Name);
    await joinGame(p3, roomCode, p3Name);

    // All 3 names appear for all contexts
    for (const page of [p1, p2, p3]) {
      await expect(page.locator('[data-testid="player-list-item"]')).toHaveCount(3, {
        timeout: 10_000,
      });
    }

    // Non-host contexts do NOT show the Start button
    await expect(p2.getByRole("button", { name: /Start Game/ })).toHaveCount(0);
    await expect(p3.getByRole("button", { name: /Start Game/ })).toHaveCount(0);

    // Host sees Start button
    await expect(p1.getByRole("button", { name: /Start Game/ })).toBeVisible();

    // After start, all contexts navigate to session
    await startGame(p1);
    await Promise.all([waitForSession(p1), waitForSession(p2), waitForSession(p3)]);
  });
});
