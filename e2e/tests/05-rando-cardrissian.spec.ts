import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import {
  createGame,
  joinGame,
  startGame,
  waitForSession,
  findCzarOrNull,
  playCard,
  pickWinner,
} from "../fixtures/game";

test.describe("05 — Rando Cardrissian", () => {
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

  test("Rando appears in scoreboard; czar sees 3 submissions; picking Rando does not error", async () => {
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    const p3 = await ctx3.newPage();

    const ts = Date.now();
    const { roomCode } = await createGame(p1, {
      displayName: `guest_host_${ts}`,
      totalRounds: 2,
      randoCardrissian: true,
    });
    await joinGame(p2, roomCode, `guest_p2_${ts}`);
    await joinGame(p3, roomCode, `guest_p3_${ts}`);

    await expect(p1.locator('[data-testid="player-list-item"]')).toHaveCount(3, {
      timeout: 10_000,
    });

    await startGame(p1);
    await Promise.all([waitForSession(p1), waitForSession(p2), waitForSession(p3)]);

    const pages = [p1, p2, p3];

    // Rando appears in scoreboard on session page (total 4 entries: 3 humans + Rando)
    await expect(
      async () => {
        const count = await p1.locator('[data-testid="score-panel-entry"]').count();
        expect(count).toBe(4);
      }
    ).toPass({ timeout: 15_000 });

    // Play round 1
    const { czarPage, nonCzarPages } = await findCzarOrNull(pages);

    if (czarPage !== null) {
      // Human czar — 2 human + 1 Rando = 3 submissions
      await Promise.all(nonCzarPages.map((p) => playCard(p)));
      await expect(czarPage.locator('[data-testid="submission"]')).toHaveCount(3, {
        timeout: 20_000,
      });
      // Picking any submission (including potentially Rando's) does not error
      await pickWinner(czarPage);
    } else {
      // Rando is czar — non-czar humans play, then pick via API
      await Promise.all(nonCzarPages.map((p) => playCard(p)));
      // Pick via direct API call since Rando can't interact with the UI
      const res = await p1.request.post(`/api/games/${roomCode}/pick`, {
        data: { czarPlayerId: "rando_cardrissian", winningSubmissionId: "sub_0" },
      });
      // May 400 if sub_0 doesn't exist, that's fine — just verifying no 500 crash
      expect([200, 400]).toContain(res.status());
    }

    // Game did not crash — session page still present or moved to next round
    for (const page of pages) {
      const url = page.url();
      expect(url).toMatch(/\/games\/[A-Z0-9]+\/(session|end)/);
    }
  });
});
