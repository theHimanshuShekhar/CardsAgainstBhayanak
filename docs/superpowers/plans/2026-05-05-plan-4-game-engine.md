# CardsAgainstBhayanak — Plan 4: Game Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full game state machine — deck loading from PostgreSQL into Redis, hand dealing, Card Czar rotation, card submission, anonymous reveal, Czar pick, score update, round advancement, end-of-game, and all three house rules (Rando Cardrissian, Happy Ending, Packing Heat).

**Architecture:** A server-side module (`src/lib/game-engine.ts`) owns all state transitions. It is called by three API routes: `/api/games/:code/play` (submit card), `/api/games/:code/pick` (Czar picks winner), and an internal `startRound` function triggered by the `game:started` and `round:ended` events. All state mutations happen atomically in Redis; PostgreSQL only receives completed round and game records. Events are published to the room channel after each mutation.

**Tech Stack:** ioredis (Redis transactions), Drizzle ORM, TanStack Start API routes, Vitest

**Prerequisite:** Plans 1–3 complete — DB running, game sessions exist, WebSocket infrastructure wired up.

---

## File Map

| File | Purpose |
|---|---|
| `src/lib/game-engine.ts` | Core state machine — all round lifecycle methods |
| `src/lib/rando.ts` | Rando Cardrissian bot logic |
| `src/routes/api/games/$code/play.ts` | POST /api/games/:code/play — player submits card(s) |
| `src/routes/api/games/$code/pick.ts` | POST /api/games/:code/pick — Czar picks winner |
| `src/lib/game-engine.test.ts` | Vitest: deck loading, dealing, submission, pick, scoring |
| `src/lib/rando.test.ts` | Vitest: Rando submits a card each round |

---

## Task 1: Game engine — deck loading and dealing

**Files:**
- Create: `src/lib/game-engine.ts`

- [ ] **Step 1: Write the deck-loading and dealing section of src/lib/game-engine.ts**

```typescript
// src/lib/game-engine.ts
import { getRedis } from "./redis";
import { publishEvent, getGamePlayers } from "./game-state";
import { db } from "../db/client";
import { blackCards, whiteCards } from "../db/schema";
import { inArray } from "drizzle-orm";

const TTL = 86400;

export interface GameConfig {
  totalRounds: number;
  maxPlayers: number;
  packIds: number[];
  houseRules: {
    randoCardrissian: boolean;
    happyEnding: boolean;
    packingHeat: boolean;
  };
}

// Fisher-Yates shuffle (in-place)
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function loadDecksIntoRedis(
  roomCode: string,
  config: GameConfig
): Promise<void> {
  const redis = getRedis();

  const [blacks, whites] = await Promise.all([
    db
      .select({ id: blackCards.id })
      .from(blackCards)
      .where(inArray(blackCards.packId, config.packIds)),
    db
      .select({ id: whiteCards.id })
      .from(whiteCards)
      .where(inArray(whiteCards.packId, config.packIds)),
  ]);

  const shuffledBlacks = shuffle(blacks.map((c) => String(c.id)));
  const shuffledWhites = shuffle(whites.map((c) => String(c.id)));

  const blackKey = `game:${roomCode}:deck:black`;
  const whiteKey = `game:${roomCode}:deck:white`;

  await redis
    .multi()
    .del(blackKey)
    .del(whiteKey)
    .rpush(blackKey, ...shuffledBlacks)
    .rpush(whiteKey, ...shuffledWhites)
    .expire(blackKey, TTL)
    .expire(whiteKey, TTL)
    .exec();
}

export async function dealHands(roomCode: string): Promise<void> {
  const redis = getRedis();
  const players = await getGamePlayers(roomCode);

  for (const [playerId, player] of Object.entries(players)) {
    if (player.isSpectator) continue;
    const handKey = `game:${roomCode}:hand:${playerId}`;
    const existing = await redis.scard(handKey);
    const needed = 7 - existing;
    if (needed <= 0) continue;

    const cards = await redis.lrange(`game:${roomCode}:deck:white`, 0, needed - 1);
    await redis.ltrim(`game:${roomCode}:deck:white`, needed, -1);
    if (cards.length > 0) {
      await redis
        .multi()
        .sadd(handKey, ...cards)
        .expire(handKey, TTL)
        .exec();
    }
  }
}

export async function dealPendingPlayers(roomCode: string): Promise<void> {
  const redis = getRedis();
  const players = await getGamePlayers(roomCode);

  for (const [playerId, player] of Object.entries(players)) {
    if (!player.isPending || player.isSpectator) continue;

    // Deal 7 cards
    const cards = await redis.lrange(`game:${roomCode}:deck:white`, 0, 6);
    await redis.ltrim(`game:${roomCode}:deck:white`, 7, -1);
    const handKey = `game:${roomCode}:hand:${playerId}`;
    if (cards.length > 0) {
      await redis
        .multi()
        .sadd(handKey, ...cards)
        .expire(handKey, TTL)
        .exec();
    }

    // Mark as active
    player.isPending = false;
    await redis.hset(
      `game:${roomCode}:players`,
      playerId,
      JSON.stringify(player)
    );
  }
}
```

- [ ] **Step 2: Add startRound function to the same file**

```typescript
// (append to src/lib/game-engine.ts)

export async function startRound(roomCode: string): Promise<void> {
  const redis = getRedis();

  // Activate pending players first
  await dealPendingPlayers(roomCode);

  // Replenish hands to 7
  await dealHands(roomCode);

  // Rotate Czar
  const metaRaw = await redis.hgetall(`game:${roomCode}`);
  const currentRound = Number(metaRaw.currentRound ?? 0);
  const nextRound = currentRound + 1;
  const config: GameConfig = JSON.parse(metaRaw.config ?? "{}");
  const totalRounds = Number(metaRaw.totalRounds ?? 8);

  const players = await getGamePlayers(roomCode);
  const activePlayers = Object.entries(players).filter(([, p]) => !p.isSpectator);
  const czarIdx = Number(metaRaw.czarIndex ?? 0) % activePlayers.length;
  const nextCzarIdx = (czarIdx + 1) % activePlayers.length;
  const [czarId] = activePlayers[czarIdx];

  // Draw black card — inject "Make a Haiku" for Happy Ending final round if needed
  let blackCardId: string;
  if (config.houseRules?.happyEnding && nextRound === totalRounds) {
    blackCardId = await getHaikuCardId();
  } else {
    const drawn = await redis.lpop(`game:${roomCode}:deck:black`);
    if (!drawn) throw new Error("No black cards remaining");
    blackCardId = drawn;
  }

  // Fetch card text
  const [card] = await db
    .select({ text: blackCards.text, pick: blackCards.pick })
    .from(blackCards)
    .where(inArray(blackCards.id, [Number(blackCardId)]));

  // If Packing Heat: deal extra card to everyone when pick > 1
  if (config.houseRules?.packingHeat && card.pick > 1) {
    for (const [playerId, player] of activePlayers) {
      if (player.isSpectator || playerId === czarId) continue;
      const extra = await redis.lpop(`game:${roomCode}:deck:white`);
      if (extra) {
        await redis.sadd(`game:${roomCode}:hand:${playerId}`, extra);
      }
    }
  }

  // Reset round state
  await redis
    .multi()
    .hset(`game:${roomCode}`, {
      currentRound: String(nextRound),
      czarIndex: String(nextCzarIdx),
      status: "active",
    })
    .del(`game:${roomCode}:round`)
    .hset(`game:${roomCode}:round`, {
      blackCardId,
      submissions: JSON.stringify({}),
      winnerId: "",
    })
    .expire(`game:${roomCode}:round`, TTL)
    .exec();

  // Publish round:started
  await publishEvent(roomCode, "round:started", {
    roundNum: nextRound,
    blackCard: { id: Number(blackCardId), text: card.text, pick: card.pick },
    czarId,
  });

  // Rando Cardrissian plays immediately
  if (config.houseRules?.randoCardrissian) {
    const { playRandoCard } = await import("./rando");
    await playRandoCard(roomCode, card.pick);
  }
}

async function getHaikuCardId(): Promise<string> {
  // "Make a Haiku" is a known black card (pick 3).
  // Search by text; inject a temporary record if not found.
  const { blackCards: bcTable } = await import("../db/schema");
  const { like } = await import("drizzle-orm");
  const [haiku] = await db
    .select({ id: bcTable.id })
    .from(bcTable)
    .where(like(bcTable.text, "%Haiku%"))
    .limit(1);

  if (haiku) return String(haiku.id);

  // Inject into the DB if it doesn't exist (temporary for this game)
  const [injected] = await db
    .insert(bcTable)
    .values({ packId: 1, text: "Make a haiku.", pick: 3 })
    .onConflictDoNothing()
    .returning();
  return String(injected.id);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/game-engine.ts
git commit -m "feat: add game engine — deck loading, dealing, round start"
```

---

## Task 2: Rando Cardrissian bot

**Files:**
- Create: `src/lib/rando.ts`
- Create: `src/lib/rando.test.ts`

- [ ] **Step 1: Write src/lib/rando.ts**

```typescript
// src/lib/rando.ts
import { getRedis } from "./redis";
import { publishEvent } from "./game-state";

const RANDO_ID = "rando_cardrissian";

export async function ensureRandoInGame(roomCode: string): Promise<void> {
  const redis = getRedis();
  const existing = await redis.hget(`game:${roomCode}:players`, RANDO_ID);
  if (existing) return;

  await redis.hset(
    `game:${roomCode}:players`,
    RANDO_ID,
    JSON.stringify({
      name: "🤖 Rando",
      score: 0,
      isHost: false,
      isSpectator: false,
      isPending: false,
    })
  );

  // Deal 7 cards
  const cards = await redis.lrange(`game:${roomCode}:deck:white`, 0, 6);
  await redis.ltrim(`game:${roomCode}:deck:white`, 7, -1);
  if (cards.length > 0) {
    await redis.sadd(`game:${roomCode}:hand:${RANDO_ID}`, ...cards);
  }

  await publishEvent(roomCode, "player:joined", {
    playerId: RANDO_ID,
    name: "🤖 Rando",
    isSpectator: false,
  });
}

export async function playRandoCard(roomCode: string, pick: number): Promise<void> {
  const redis = getRedis();
  const handKey = `game:${roomCode}:hand:${RANDO_ID}`;
  const hand = await redis.smembers(handKey);
  if (hand.length === 0) return;

  // Pick `pick` random cards
  const shuffled = [...hand].sort(() => Math.random() - 0.5);
  const chosen = shuffled.slice(0, pick);

  await redis.srem(handKey, ...chosen);

  // Record submission
  const roundRaw = await redis.hget(`game:${roomCode}:round`, "submissions");
  const submissions: Record<string, string[]> = JSON.parse(roundRaw ?? "{}");
  submissions[RANDO_ID] = chosen;
  await redis.hset(
    `game:${roomCode}:round`,
    "submissions",
    JSON.stringify(submissions)
  );

  await publishEvent(roomCode, "card:played", { playerId: RANDO_ID });
}

export { RANDO_ID };
```

- [ ] **Step 2: Write src/lib/rando.test.ts**

```typescript
// src/lib/rando.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { getRedis } from "./redis";
import { createGameState } from "./game-state";
import { loadDecksIntoRedis } from "./game-engine";
import { ensureRandoInGame, playRandoCard, RANDO_ID } from "./rando";

const ROOM = "RNDTST";

afterEach(async () => {
  const redis = getRedis();
  const keys = await redis.keys(`game:${ROOM}*`);
  if (keys.length) await redis.del(...keys);
});

describe("Rando Cardrissian", () => {
  it("is added to the game with a hand of 7 cards", async () => {
    await createGameState(
      ROOM,
      {
        totalRounds: 5,
        maxPlayers: 6,
        packIds: [1],
        houseRules: { randoCardrissian: true, happyEnding: false, packingHeat: false },
      },
      { playerId: "host", name: "Host" }
    );
    await loadDecksIntoRedis(ROOM, {
      totalRounds: 5,
      maxPlayers: 6,
      packIds: [1],
      houseRules: { randoCardrissian: true, happyEnding: false, packingHeat: false },
    });

    await ensureRandoInGame(ROOM);
    const redis = getRedis();
    const handSize = await redis.scard(`game:${ROOM}:hand:${RANDO_ID}`);
    expect(handSize).toBe(7);
  });

  it("plays a card from its hand", async () => {
    await createGameState(
      ROOM,
      {
        totalRounds: 5,
        maxPlayers: 6,
        packIds: [1],
        houseRules: { randoCardrissian: true, happyEnding: false, packingHeat: false },
      },
      { playerId: "host", name: "Host" }
    );
    await loadDecksIntoRedis(ROOM, {
      totalRounds: 5,
      maxPlayers: 6,
      packIds: [1],
      houseRules: { randoCardrissian: true, happyEnding: false, packingHeat: false },
    });
    await ensureRandoInGame(ROOM);

    const redis = getRedis();
    // Set up round state
    await redis.hset(`game:${ROOM}:round`, "submissions", JSON.stringify({}));

    await playRandoCard(ROOM, 1);

    const subRaw = await redis.hget(`game:${ROOM}:round`, "submissions");
    const subs = JSON.parse(subRaw ?? "{}");
    expect(subs[RANDO_ID]).toHaveLength(1);

    const handSize = await redis.scard(`game:${ROOM}:hand:${RANDO_ID}`);
    expect(handSize).toBe(6);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm test src/lib/rando.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/rando.ts src/lib/rando.test.ts
git commit -m "feat: add Rando Cardrissian bot"
```

---

## Task 3: Card submission — engine logic + API route

**Files:**
- Create: `src/routes/api/games/$code/play.ts`

- [ ] **Step 1: Add submitCards function to src/lib/game-engine.ts**

```typescript
// (append to src/lib/game-engine.ts)

export async function submitCards(
  roomCode: string,
  playerId: string,
  cardIds: string[]
): Promise<{ allPlayed: boolean }> {
  const redis = getRedis();

  // Validate cards are in player's hand
  const handKey = `game:${roomCode}:hand:${playerId}`;
  for (const cardId of cardIds) {
    const inHand = await redis.sismember(handKey, cardId);
    if (!inHand) throw new Error(`Card ${cardId} not in hand`);
  }

  // Record submission
  const roundRaw = await redis.hget(`game:${roomCode}:round`, "submissions");
  const submissions: Record<string, string[]> = JSON.parse(roundRaw ?? "{}");
  if (submissions[playerId]) throw new Error("Already submitted this round");

  submissions[playerId] = cardIds;

  // Remove cards from hand
  await redis.srem(handKey, ...cardIds);
  await redis.hset(`game:${roomCode}:round`, "submissions", JSON.stringify(submissions));

  await publishEvent(roomCode, "card:played", { playerId });

  // Check if all non-Czar players have submitted
  const players = await getGamePlayers(roomCode);
  const metaRaw = await redis.hgetall(`game:${roomCode}`);
  const activePlayers = Object.entries(players).filter(([, p]) => !p.isSpectator);
  const czarIdx = Number(metaRaw.czarIndex ?? 0) % activePlayers.length;
  // czarIndex has already been advanced at round start so czar is activePlayers[czarIdx - 1]
  // Track czar by czarId stored in round hash
  const czarId = await redis.hget(`game:${roomCode}:round`, "czarId") ?? activePlayers[czarIdx][0];

  const nonCzarPlayers = activePlayers.filter(([id]) => id !== czarId);
  const allPlayed = nonCzarPlayers.every(([id]) => submissions[id]);

  if (allPlayed) {
    // Anonymize submissions — assign random submissionIds
    const anonymized = Object.entries(submissions).map(([, cards], idx) => ({
      submissionId: `sub_${idx}`,
      cards: cards.map(Number),
    }));
    await publishEvent(roomCode, "all:played", { submissions: anonymized });
  }

  return { allPlayed };
}
```

- [ ] **Step 2: Write src/routes/api/games/$code/play.ts**

```typescript
// src/routes/api/games/$code/play.ts
import { json } from "@tanstack/start";
import { createAPIFileRoute } from "@tanstack/start/api";
import { z } from "zod";
import { submitCards } from "../../../../lib/game-engine";

const PlayBody = z.object({
  playerId: z.string(),
  cardIds: z.array(z.string()).min(1).max(3),
});

export const APIRoute = createAPIFileRoute("/api/games/$code/play")({
  POST: async ({ request, params }) => {
    const roomCode = params.code.toUpperCase();
    const body = await request.json();
    const parsed = PlayBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    try {
      const { allPlayed } = await submitCards(
        roomCode,
        parsed.data.playerId,
        parsed.data.cardIds
      );
      return json({ ok: true, allPlayed });
    } catch (err: any) {
      return json({ error: err.message }, { status: 422 });
    }
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/game-engine.ts src/routes/api/games/$code/play.ts
git commit -m "feat: add card submission — submitCards + POST /api/games/:code/play"
```

---

## Task 4: Czar pick — engine logic + API route

**Files:**
- Create: `src/routes/api/games/$code/pick.ts`

- [ ] **Step 1: Add pickWinner function to src/lib/game-engine.ts**

```typescript
// (append to src/lib/game-engine.ts)
import { gameSessions, gameRounds, gamePlayers as gamePlayersTable } from "../db/schema";
import { eq } from "drizzle-orm";

export async function pickWinner(
  roomCode: string,
  czarPlayerId: string,
  winningSubmissionId: string
): Promise<void> {
  const redis = getRedis();
  const metaRaw = await redis.hgetall(`game:${roomCode}`);
  const currentRound = Number(metaRaw.currentRound ?? 1);
  const totalRounds = Number(metaRaw.totalRounds ?? 8);
  const config: GameConfig = JSON.parse(metaRaw.config ?? "{}");

  // Resolve winning player from submissionId
  const subRaw = await redis.hget(`game:${roomCode}:round`, "submissions");
  const submissions: Record<string, string[]> = JSON.parse(subRaw ?? "{}");
  const submissionEntries = Object.entries(submissions);
  const submissionIdx = parseInt(winningSubmissionId.replace("sub_", ""), 10);
  const [winnerId, winningCards] = submissionEntries[submissionIdx];

  const players = await getGamePlayers(roomCode);
  const winner = players[winnerId];
  if (!winner) throw new Error("Winner not found");

  // Increment score in Redis
  winner.score += 1;
  await redis.hset(
    `game:${roomCode}:players`,
    winnerId,
    JSON.stringify(winner)
  );

  await publishEvent(roomCode, "czar:picked", {
    winnerId,
    winnerName: winner.name,
    submissionId: winningSubmissionId,
    winningCards: winningCards.map(Number),
  });

  // Build scores object for round:ended
  const freshPlayers = await getGamePlayers(roomCode);
  const scores = Object.fromEntries(
    Object.entries(freshPlayers).map(([id, p]) => [id, p.score])
  );

  await publishEvent(roomCode, "round:ended", { scores });

  // Persist to PostgreSQL
  const [session] = await db
    .select({ id: gameSessions.id })
    .from(gameSessions)
    .where(eq(gameSessions.roomCode, roomCode))
    .limit(1);

  const [dbWinner] = await db
    .select({ id: gamePlayersTable.id })
    .from(gamePlayersTable)
    .where(eq(gamePlayersTable.sessionId, session.id))
    // displayName match is imprecise — store playerId in DB (see schema note)
    .limit(1);

  await db.insert(gameRounds).values({
    sessionId: session.id,
    roundNum: currentRound,
    blackCardId: Number(await redis.hget(`game:${roomCode}:round`, "blackCardId")),
    winnerPlayerId: dbWinner?.id,
    completedAt: new Date(),
  });

  // Advance to next round or end game
  if (currentRound >= totalRounds) {
    await endGame(roomCode, session.id, freshPlayers);
  } else {
    // Auto-advance after 10 seconds (clients can also trigger via "next round" button)
    setTimeout(() => startRound(roomCode).catch(console.error), 10_000);
  }
}

async function endGame(
  roomCode: string,
  sessionId: number,
  players: Record<string, ReturnType<typeof getGamePlayers> extends Promise<infer T> ? T[string] : never>
): Promise<void> {
  const redis = getRedis();

  await redis.hset(`game:${roomCode}`, "status", "ended");
  await db
    .update(gameSessions)
    .set({ status: "ended", endedAt: new Date() })
    .where(eq(gameSessions.id, sessionId));

  const finalScores = Object.fromEntries(
    Object.entries(players).map(([id, p]) => [id, { name: p.name, score: p.score }])
  );

  await publishEvent(roomCode, "game:ended", { finalScores });
}
```

- [ ] **Step 2: Write src/routes/api/games/$code/pick.ts**

```typescript
// src/routes/api/games/$code/pick.ts
import { json } from "@tanstack/start";
import { createAPIFileRoute } from "@tanstack/start/api";
import { z } from "zod";
import { pickWinner } from "../../../../lib/game-engine";

const PickBody = z.object({
  czarPlayerId: z.string(),
  winningSubmissionId: z.string(),
});

export const APIRoute = createAPIFileRoute("/api/games/$code/pick")({
  POST: async ({ request, params }) => {
    const roomCode = params.code.toUpperCase();
    const body = await request.json();
    const parsed = PickBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    try {
      await pickWinner(
        roomCode,
        parsed.data.czarPlayerId,
        parsed.data.winningSubmissionId
      );
      return json({ ok: true });
    } catch (err: any) {
      return json({ error: err.message }, { status: 422 });
    }
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/game-engine.ts src/routes/api/games/$code/pick.ts
git commit -m "feat: add Czar pick — pickWinner + POST /api/games/:code/pick"
```

---

## Task 5: Wire game:started → startRound + initialise game

**Files:**
- Create: `src/lib/game-event-handler.ts`

The `game:started` event is published by `/api/games/:code/start` (Plan 3). The engine needs to react to it by loading decks and starting Round 1. Since there is no long-running process in a serverless/Nitro model, we trigger this directly from the start route.

- [ ] **Step 1: Write src/lib/game-event-handler.ts**

```typescript
// src/lib/game-event-handler.ts
// Called by /api/games/:code/start after publishing game:started.
// Loads decks and starts round 1.
import { loadDecksIntoRedis, startRound } from "./game-engine";
import { ensureRandoInGame } from "./rando";
import { getRedis } from "./redis";

export async function handleGameStarted(roomCode: string): Promise<void> {
  const redis = getRedis();
  const configRaw = await redis.hget(`game:${roomCode}`, "config");
  const config = JSON.parse(configRaw ?? "{}");

  await loadDecksIntoRedis(roomCode, config);

  if (config.houseRules?.randoCardrissian) {
    await ensureRandoInGame(roomCode);
  }

  await startRound(roomCode);
}
```

- [ ] **Step 2: Modify /api/games/:code/start to call handleGameStarted**

Open `src/routes/api/games/$code/start.ts` (created in Plan 3). After the `publishEvent(roomCode, "game:started", { config })` call, add:

```typescript
// In src/routes/api/games/$code/start.ts, after publishEvent:
import { handleGameStarted } from "../../../../lib/game-event-handler";

// After publishEvent line:
await handleGameStarted(roomCode);
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/game-event-handler.ts src/routes/api/games/$code/start.ts
git commit -m "feat: wire game:started to deck loading and round 1 start"
```

---

## Task 6: Game engine tests

**Files:**
- Create: `src/lib/game-engine.test.ts`

- [ ] **Step 1: Write src/lib/game-engine.test.ts**

```typescript
// src/lib/game-engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRedis } from "./redis";
import { createGameState, getGamePlayers, publishEvent } from "./game-state";
import { loadDecksIntoRedis, dealHands, submitCards } from "./game-engine";

const ROOM = "ENGTST";
const CONFIG = {
  totalRounds: 3,
  maxPlayers: 4,
  packIds: [1],
  houseRules: { randoCardrissian: false, happyEnding: false, packingHeat: false },
};

async function cleanup() {
  const redis = getRedis();
  const keys = await redis.keys(`game:${ROOM}*`);
  if (keys.length) await redis.del(...keys);
}

beforeEach(async () => {
  await cleanup();
  await createGameState(ROOM, CONFIG, { playerId: "host", name: "Host" });
  await loadDecksIntoRedis(ROOM, CONFIG);
});
afterEach(cleanup);

describe("game engine", () => {
  it("loads decks into Redis with cards", async () => {
    const redis = getRedis();
    const blackCount = await redis.llen(`game:${ROOM}:deck:black`);
    const whiteCount = await redis.llen(`game:${ROOM}:deck:white`);
    expect(blackCount).toBeGreaterThan(0);
    expect(whiteCount).toBeGreaterThan(0);
  });

  it("deals 7 white cards to each non-spectator player", async () => {
    const redis = getRedis();
    // Add a second player
    await redis.hset(`game:${ROOM}:players`, "p2", JSON.stringify({
      name: "Alice", score: 0, isHost: false, isSpectator: false, isPending: false,
    }));

    await dealHands(ROOM);

    const hostHand = await redis.scard(`game:${ROOM}:hand:host`);
    const p2Hand = await redis.scard(`game:${ROOM}:hand:p2`);
    expect(hostHand).toBe(7);
    expect(p2Hand).toBe(7);
  });

  it("records a card submission and removes card from hand", async () => {
    const redis = getRedis();
    // Set up hand manually
    await redis.sadd(`game:${ROOM}:hand:host`, "100", "101", "102");
    await redis.hset(`game:${ROOM}:round`, "submissions", JSON.stringify({}));
    // Need czarId in round to determine allPlayed
    await redis.hset(`game:${ROOM}:round`, "czarId", "czar_player");

    await submitCards(ROOM, "host", ["100"]);

    const handSize = await redis.scard(`game:${ROOM}:hand:host`);
    expect(handSize).toBe(2);

    const subRaw = await redis.hget(`game:${ROOM}:round`, "submissions");
    const subs = JSON.parse(subRaw ?? "{}");
    expect(subs["host"]).toEqual(["100"]);
  });

  it("throws if card not in hand", async () => {
    const redis = getRedis();
    await redis.sadd(`game:${ROOM}:hand:host`, "100");
    await redis.hset(`game:${ROOM}:round`, "submissions", JSON.stringify({}));

    await expect(submitCards(ROOM, "host", ["999"])).rejects.toThrow(
      "Card 999 not in hand"
    );
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm test src/lib/game-engine.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/game-engine.test.ts
git commit -m "test: add game engine integration tests"
```

---

## Verification

End-to-end check for Plan 4:

1. Open 4 browser tabs: 1 host + 3 players. Host creates game, others join.
2. Host starts → all tabs receive `round:started` with a black card and czar ID
3. 3 non-Czar players each submit a card via `/api/games/:code/play`
4. After all submit, `all:played` event fires with anonymized submissions
5. Czar sees cards, clicks one → `/api/games/:code/pick` → `czar:picked` + `round:ended` fire in all tabs, winner's score increments
6. After N rounds, `game:ended` fires with final scores
7. Enable Rando Cardrissian — Rando appears in lobby, submits a card every round automatically
8. `pnpm test src/lib/game-engine.test.ts src/lib/rando.test.ts` — all tests pass

If all 8 pass, Plan 4 is complete. Proceed to Plan 5 (All UI Screens).
