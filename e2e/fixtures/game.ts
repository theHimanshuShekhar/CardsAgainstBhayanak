import { expect, type Page } from "@playwright/test";

export interface GameOptions {
  displayName?: string;
  totalRounds?: number;
  randoCardrissian?: boolean;
  happyEnding?: boolean;
  packingHeat?: boolean;
}

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

  await page.goto("/games/create");

  // Display name is the first input (no type attr)
  await page.locator("input").first().fill(displayName);

  // Rounds is the first number input
  await page.locator('input[type="number"]').first().fill(String(totalRounds));

  if (randoCardrissian) await page.getByLabel("Rando Cardrissian").check();
  if (happyEnding) await page.getByLabel("Happy Ending").check();
  if (packingHeat) await page.getByLabel("Packing Heat").check();

  await page.getByRole("button", { name: "Create Game" }).click();
  await page.waitForURL(/\/games\/[A-Z0-9]+\/lobby/);

  const url = new URL(page.url());
  const roomCode = url.pathname.split("/")[2];
  const playerId = url.searchParams.get("playerId") ?? "";

  return { roomCode, playerId };
}

export async function joinGame(
  page: Page,
  roomCode: string,
  displayName: string,
  options: { spectator?: boolean } = {}
): Promise<{ playerId: string }> {
  await page.goto("/games/join");

  // Display name is the first input
  await page.locator("input").first().fill(displayName);

  // Room code input has placeholder XXXXXX
  await page.locator('input[placeholder="XXXXXX"]').fill(roomCode);

  if (options.spectator) {
    await page.getByRole("button", { name: "Spectator" }).click();
  }

  await page.getByRole("button", { name: "Join Game" }).click();
  await page.waitForURL(/\/games\/[A-Z0-9]+\/(lobby|session)/);

  const url = new URL(page.url());
  const playerId = url.searchParams.get("playerId") ?? "";
  return { playerId };
}

export async function startGame(hostPage: Page): Promise<void> {
  await hostPage.getByRole("button", { name: /Start Game/ }).click();
}

export async function waitForSession(page: Page): Promise<void> {
  await page.waitForURL(/\/games\/[A-Z0-9]+\/session/, { timeout: 30_000 });
}

/** Returns the czar page and non-czar pages. Throws if no czar is found (use findCzarOrNull for Rando rounds). */
export async function findCzar(
  pages: Page[]
): Promise<{ czarPage: Page; nonCzarPages: Page[] }> {
  // Wait for the czar indicator to appear on one of the pages
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
  // Check each page — if none shows the czar text within 5s, Rando is czar
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
  // Wait for the card to be marked as played
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

  await Promise.all(nonCzarPages.map((p) => playCard(p)));
  await pickWinner(czarPage);

  // Wait for round:ended (scores update) before returning
  await expect(czarPage.locator('[data-testid="score-panel-entry"]').first()).toBeVisible({
    timeout: 15_000,
  });
}
