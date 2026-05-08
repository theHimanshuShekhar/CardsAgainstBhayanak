import { expect, type Page } from "@playwright/test";

export interface GameOptions {
  displayName?: string;
  totalRounds?: number;
  randoCardrissian?: boolean;
  happyEnding?: boolean;
  packingHeat?: boolean;
}

/** Create a game via API and navigate host page to lobby. */
export async function createGame(
  page: Page,
  options: GameOptions = {}
): Promise<{ roomCode: string; playerId: string }> {
  const {
    displayName = `host_${Date.now()}`,
    totalRounds = 2,
    randoCardrissian = false,
    happyEnding = false,
    packingHeat = false,
  } = options;

  const resp = await page.request.post("/api/games/", {
    data: {
      displayName,
      totalRounds,
      maxPlayers: 10,
      packIds: [1],
      houseRules: { randoCardrissian, happyEnding, packingHeat },
    },
  });

  if (!resp.ok()) {
    throw new Error(`createGame API failed: ${resp.status()} ${await resp.text()}`);
  }

  const { roomCode, playerId } = await resp.json();
  await page.goto(`/games/${roomCode}/lobby?playerId=${playerId}`);
  // Wait for lobby to mount (player list or "Waiting…" text)
  await page.waitForSelector('[data-testid="player-list-item"], .text-slate-400', {
    timeout: 15_000,
  });

  return { roomCode, playerId };
}

/** Join a game via API and navigate the page to lobby (or session if game is active). */
export async function joinGame(
  page: Page,
  roomCode: string,
  displayName: string,
  options: { spectator?: boolean } = {}
): Promise<{ playerId: string }> {
  const resp = await page.request.post(`/api/games/${roomCode}/join`, {
    data: { displayName, spectator: options.spectator ?? false },
  });

  if (!resp.ok()) {
    throw new Error(`joinGame API failed: ${resp.status()} ${await resp.text()}`);
  }

  const data = await resp.json();
  const playerId = String(data.playerId);

  if (data.status === "active") {
    await page.goto(`/games/${roomCode}/session?playerId=${playerId}`);
    await page.waitForSelector('[data-testid="black-card"], [data-testid="round-display"]', {
      timeout: 15_000,
    });
  } else {
    await page.goto(`/games/${roomCode}/lobby?playerId=${playerId}`);
    await page.waitForSelector('[data-testid="player-list-item"]', {
      timeout: 15_000,
    });
  }

  return { playerId };
}

export async function startGame(hostPage: Page): Promise<void> {
  // Wait for the Start button to be interactive (signals React has hydrated)
  const btn = hostPage.getByRole("button", { name: /Start Game/ });
  await expect(btn).toBeEnabled({ timeout: 15_000 });
  await btn.click();
}

export async function waitForSession(page: Page): Promise<void> {
  await page.waitForURL(/\/games\/[A-Z0-9]+\/session/, { timeout: 30_000 });
}

/** Returns the czar page and non-czar pages. Throws if no czar is found (use findCzarOrNull for Rando rounds). */
export async function findCzar(
  pages: Page[]
): Promise<{ czarPage: Page; nonCzarPages: Page[] }> {
  const czarPage = await Promise.race(
    pages.map(async (p) => {
      await expect(
        p.getByText("Czar — wait for submissions")
      ).toBeVisible({ timeout: 20_000 });
      return p;
    })
  );
  return {
    czarPage,
    nonCzarPages: pages.filter((p) => p !== czarPage),
  };
}

/** Like findCzar but returns czarPage=null when Rando Cardrissian is czar. */
export async function findCzarOrNull(
  pages: Page[]
): Promise<{ czarPage: Page | null; nonCzarPages: Page[] }> {
  const results = await Promise.all(
    pages.map(async (p) => {
      const visible = await p
        .getByText("Czar — wait for submissions")
        .isVisible()
        .catch(() => false);
      return visible ? p : null;
    })
  );
  const czarPage = results.find((p): p is Page => p !== null) ?? null;
  return { czarPage, nonCzarPages: czarPage ? pages.filter((p) => p !== czarPage) : pages };
}

export async function playCard(page: Page): Promise<void> {
  const card = page.locator('[data-testid="hand-card"]:not([data-played="true"])').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(
    page.locator('[data-testid="hand-card"][data-played="true"]')
  ).toBeVisible({ timeout: 10_000 });
}

export async function pickWinner(czarPage: Page): Promise<void> {
  const submission = czarPage.locator('[data-testid="submission"]').first();
  await expect(submission).toBeVisible({ timeout: 20_000 });
  await submission.click();
}

export async function waitForRound(page: Page, num: number): Promise<void> {
  await expect(page.locator('[data-testid="round-display"]')).toContainText(
    `Round ${num}/`,
    { timeout: 15_000 }
  );
}

export async function getHandSize(page: Page): Promise<number> {
  return page.locator('[data-testid="hand-card"]').count();
}

export async function getScores(page: Page): Promise<Record<string, number>> {
  const entries = await page.locator('[data-testid="score-panel-entry"]').all();
  const scores: Record<string, number> = {};
  for (const entry of entries) {
    const player = await entry.getAttribute("data-player");
    const score = await entry.getAttribute("data-score");
    if (player !== null && score !== null) scores[player] = Number(score);
  }
  return scores;
}

/** Play one full round: non-czars play a card, czar picks a winner. */
export async function playRound(pages: Page[]): Promise<void> {
  const { czarPage, nonCzarPages } = await findCzar(pages);

  // Record round number AFTER czar is confirmed (so round has started)
  const ref = pages[0];
  const roundText = await ref.locator('[data-testid="round-display"]').textContent();
  const currentRound = parseInt(roundText?.match(/Round (\d+)/)?.[1] ?? "0", 10);

  await Promise.all(nonCzarPages.map((p) => playCard(p)));
  await pickWinner(czarPage);

  // Wait for next round to start (counter increments) OR game to end (any page → /end)
  await expect(async () => {
    if (pages.some((p) => p.url().includes("/end"))) return;
    const text = await ref.locator('[data-testid="round-display"]').textContent().catch(() => "");
    const nextRound = parseInt(text?.match(/Round (\d+)/)?.[1] ?? "0", 10);
    expect(nextRound).toBeGreaterThan(currentRound);
  }).toPass({ timeout: 15_000 });
}
