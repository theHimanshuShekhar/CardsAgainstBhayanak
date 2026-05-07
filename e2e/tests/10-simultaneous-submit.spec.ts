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

test.describe("10 — Simultaneous Submission", () => {
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

  test("simultaneous plays produce exactly one all:played and two submissions", async () => {
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

    // Register WS listeners on ALL pages BEFORE start so no connection is missed
    let allPlayedCountP1 = 0;
    let allPlayedCountP2 = 0;
    let allPlayedCountP3 = 0;

    p1.on("websocket", (ws) => {
      ws.on("framereceived", ({ payload }) => {
        try {
          const msg = JSON.parse(String(payload));
          if (msg.event === "all:played") allPlayedCountP1++;
        } catch { /* ignore non-JSON */ }
      });
    });
    p2.on("websocket", (ws) => {
      ws.on("framereceived", ({ payload }) => {
        try {
          const msg = JSON.parse(String(payload));
          if (msg.event === "all:played") allPlayedCountP2++;
        } catch { /* ignore non-JSON */ }
      });
    });
    p3.on("websocket", (ws) => {
      ws.on("framereceived", ({ payload }) => {
        try {
          const msg = JSON.parse(String(payload));
          if (msg.event === "all:played") allPlayedCountP3++;
        } catch { /* ignore non-JSON */ }
      });
    });

    await startGame(p1);
    await Promise.all([waitForSession(p1), waitForSession(p2), waitForSession(p3)]);

    const pages = [p1, p2, p3];
    const { czarPage, nonCzarPages } = await findCzar(pages);

    // Fire both non-czar plays simultaneously
    await Promise.all(nonCzarPages.map((p) => playCard(p)));

    // Czar sees exactly 2 submissions (no duplicates)
    await expect(czarPage.locator('[data-testid="submission"]')).toHaveCount(2, {
      timeout: 20_000,
    });

    // Verify exactly 1 all:played event was received on czar page
    const czarCount =
      czarPage === p1
        ? allPlayedCountP1
        : czarPage === p2
        ? allPlayedCountP2
        : allPlayedCountP3;
    expect(czarCount).toBe(1);

    // Round completes normally
    await pickWinner(czarPage);
  });
});
