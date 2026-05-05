# CardsAgainstBhayanak — Plan 3: Game Sessions, Lobby & WebSocket

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement game session creation, joining (player and spectator), the lobby screen with real-time player list, and the WebSocket infrastructure that fans out events to all connected clients in a room via Redis pub/sub.

**Architecture:** Three API routes handle game lifecycle (create, join, start). A Vinxi WebSocket route (`/_ws/game/:roomCode`) accepts connections, subscribes each client to a Redis pub/sub channel, and fans out all messages. Active game state lives in Redis hashes/lists/sets (24h TTL). PostgreSQL records sessions and players for history. The React Lobby screen connects to the WebSocket and updates in real time.

**Tech Stack:** TanStack Start API routes, Vinxi WS route (`defineWebSocketHandler`), ioredis pub/sub, Drizzle ORM, Vitest, React

**Prerequisite:** Plans 1 and 2 complete — DB running, schema pushed, auth working.

---

## File Map

| File | Purpose |
|---|---|
| `src/lib/room-code.ts` | Generate 6-char alphanumeric room codes |
| `src/lib/game-state.ts` | Redis game state read/write helpers |
| `src/routes/api/games/index.ts` | POST /api/games — create session |
| `src/routes/api/games/$code/join.ts` | POST /api/games/:code/join |
| `src/routes/api/games/$code/start.ts` | POST /api/games/:code/start |
| `src/routes/ws/game/$code.ts` | Vinxi WS route — WebSocket handler |
| `src/lib/ws-connections.ts` | Server-side Map: roomCode → Set of WS connections |
| `src/hooks/useGameSocket.ts` | React hook wrapping WebSocket connection |
| `src/routes/games/create.tsx` | Create Game screen |
| `src/routes/games/join.tsx` | Join Game screen |
| `src/routes/games/$code/lobby.tsx` | Lobby screen — real-time player list |
| `src/lib/room-code.test.ts` | Vitest: uniqueness and format |
| `src/lib/game-state.test.ts` | Vitest: Redis state helpers |

---

## Task 1: Room code generator

**Files:**
- Create: `src/lib/room-code.ts`
- Create: `src/lib/room-code.test.ts`

- [ ] **Step 1: Write src/lib/room-code.ts**

```typescript
// src/lib/room-code.ts
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1 — visually ambiguous

export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return code;
}
```

- [ ] **Step 2: Write src/lib/room-code.test.ts**

```typescript
// src/lib/room-code.test.ts
import { describe, it, expect } from "vitest";
import { generateRoomCode } from "./room-code";

describe("generateRoomCode", () => {
  it("generates a 6-character code", () => {
    expect(generateRoomCode()).toHaveLength(6);
  });

  it("contains only uppercase letters and digits (no I, O, 0, 1)", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateRoomCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    }
  });

  it("generates unique codes across 1000 calls", () => {
    const codes = new Set(Array.from({ length: 1000 }, generateRoomCode));
    expect(codes.size).toBeGreaterThan(990);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm test src/lib/room-code.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/room-code.ts src/lib/room-code.test.ts
git commit -m "feat: add room code generator"
```

---

## Task 2: Redis game state helpers

**Files:**
- Create: `src/lib/game-state.ts`
- Create: `src/lib/game-state.test.ts`

- [ ] **Step 1: Write src/lib/game-state.ts**

```typescript
// src/lib/game-state.ts
import { getRedis } from "./redis";

const TTL_SECONDS = 86400; // 24h

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

export interface GamePlayer {
  name: string;
  userId?: string;
  score: number;
  isHost: boolean;
  isSpectator: boolean;
  isPending: boolean;
}

export async function createGameState(
  roomCode: string,
  config: GameConfig,
  hostPlayer: { playerId: string; name: string; userId?: string }
): Promise<void> {
  const redis = getRedis();
  const key = `game:${roomCode}`;

  await redis
    .multi()
    .hset(key, {
      status: "waiting",
      currentRound: "0",
      totalRounds: String(config.totalRounds),
      czarIndex: "0",
      config: JSON.stringify(config),
    })
    .expire(key, TTL_SECONDS)
    .hset(`game:${roomCode}:players`, hostPlayer.playerId, JSON.stringify({
      name: hostPlayer.name,
      userId: hostPlayer.userId,
      score: 0,
      isHost: true,
      isSpectator: false,
      isPending: false,
    }))
    .expire(`game:${roomCode}:players`, TTL_SECONDS)
    .exec();
}

export async function getGameStatus(roomCode: string): Promise<string | null> {
  const redis = getRedis();
  return redis.hget(`game:${roomCode}`, "status");
}

export async function addPlayerToGame(
  roomCode: string,
  playerId: string,
  player: GamePlayer
): Promise<void> {
  const redis = getRedis();
  await redis
    .multi()
    .hset(`game:${roomCode}:players`, playerId, JSON.stringify(player))
    .expire(`game:${roomCode}:players`, TTL_SECONDS)
    .exec();
}

export async function getGamePlayers(
  roomCode: string
): Promise<Record<string, GamePlayer>> {
  const redis = getRedis();
  const raw = await redis.hgetall(`game:${roomCode}:players`);
  const result: Record<string, GamePlayer> = {};
  for (const [id, json] of Object.entries(raw ?? {})) {
    result[id] = JSON.parse(json);
  }
  return result;
}

export async function removePlayerFromGame(
  roomCode: string,
  playerId: string
): Promise<void> {
  const redis = getRedis();
  await redis.hdel(`game:${roomCode}:players`, playerId);
}

export async function publishEvent(
  roomCode: string,
  event: string,
  payload: unknown
): Promise<void> {
  const redis = getRedis();
  await redis.publish(
    `game:${roomCode}:channel`,
    JSON.stringify({ event, payload })
  );
}

export async function getFullGameState(roomCode: string) {
  const redis = getRedis();
  const [meta, roundRaw] = await Promise.all([
    redis.hgetall(`game:${roomCode}`),
    redis.hgetall(`game:${roomCode}:round`),
  ]);
  const players = await getGamePlayers(roomCode);
  return { meta, round: roundRaw, players };
}
```

- [ ] **Step 2: Write src/lib/game-state.test.ts**

```typescript
// src/lib/game-state.test.ts
import { describe, it, expect, afterEach } from "vitest";
import {
  createGameState,
  getGameStatus,
  addPlayerToGame,
  getGamePlayers,
  removePlayerFromGame,
} from "./game-state";
import { getRedis } from "./redis";

const TEST_ROOM = "TSTEST";

afterEach(async () => {
  const redis = getRedis();
  await redis.del(`game:${TEST_ROOM}`, `game:${TEST_ROOM}:players`);
});

describe("game-state Redis helpers", () => {
  it("creates game state with host player", async () => {
    await createGameState(
      TEST_ROOM,
      {
        totalRounds: 8,
        maxPlayers: 10,
        packIds: [1, 2],
        houseRules: { randoCardrissian: false, happyEnding: false, packingHeat: false },
      },
      { playerId: "p1", name: "Alice" }
    );

    const status = await getGameStatus(TEST_ROOM);
    expect(status).toBe("waiting");

    const players = await getGamePlayers(TEST_ROOM);
    expect(players["p1"].name).toBe("Alice");
    expect(players["p1"].isHost).toBe(true);
  });

  it("adds and removes a player", async () => {
    await createGameState(
      TEST_ROOM,
      { totalRounds: 5, maxPlayers: 6, packIds: [], houseRules: { randoCardrissian: false, happyEnding: false, packingHeat: false } },
      { playerId: "host", name: "Host" }
    );

    await addPlayerToGame(TEST_ROOM, "p2", {
      name: "Bob",
      score: 0,
      isHost: false,
      isSpectator: false,
      isPending: false,
    });

    const before = await getGamePlayers(TEST_ROOM);
    expect(Object.keys(before)).toHaveLength(2);

    await removePlayerFromGame(TEST_ROOM, "p2");
    const after = await getGamePlayers(TEST_ROOM);
    expect(Object.keys(after)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm test src/lib/game-state.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/game-state.ts src/lib/game-state.test.ts
git commit -m "feat: add Redis game state helpers"
```

---

## Task 3: WebSocket connection registry

**Files:**
- Create: `src/lib/ws-connections.ts`

- [ ] **Step 1: Write src/lib/ws-connections.ts**

```typescript
// src/lib/ws-connections.ts
// Server-side in-memory map: roomCode → active WebSocket connections.
// A single server process handles all connections; no horizontal scaling in v1.

type WsPeer = { send: (data: string) => void; id?: string };

const rooms = new Map<string, Set<WsPeer>>();

export function addConnection(roomCode: string, peer: WsPeer): void {
  if (!rooms.has(roomCode)) rooms.set(roomCode, new Set());
  rooms.get(roomCode)!.add(peer);
}

export function removeConnection(roomCode: string, peer: WsPeer): void {
  rooms.get(roomCode)?.delete(peer);
  if (rooms.get(roomCode)?.size === 0) rooms.delete(roomCode);
}

export function broadcastToRoom(roomCode: string, message: string): void {
  rooms.get(roomCode)?.forEach((peer) => {
    try {
      peer.send(message);
    } catch {
      // Peer disconnected mid-broadcast — ignore
    }
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/ws-connections.ts
git commit -m "feat: add WebSocket connection registry"
```

---

## Task 4: Vinxi WebSocket route

**Files:**
- Create: `src/routes/ws/game/$code.ts`

- [ ] **Step 1: Write src/routes/ws/game/$code.ts**

```typescript
// src/routes/ws/game/$code.ts
// Vinxi/Nitro WebSocket route — mounted at /_ws/game/:code
import { defineWebSocketHandler } from "vinxi/http";
import { newRedisSubscriber, getRedis } from "../../../lib/redis";
import {
  addConnection,
  removeConnection,
  broadcastToRoom,
} from "../../../lib/ws-connections";
import {
  getGameStatus,
  getFullGameState,
  removePlayerFromGame,
  publishEvent,
} from "../../../lib/game-state";
import { verifyToken } from "../../../lib/auth";

export default defineWebSocketHandler({
  async open(peer) {
    // Extract roomCode from URL: /_ws/game/:code
    const url = new URL(peer.request.url);
    const parts = url.pathname.split("/");
    const roomCode = parts[parts.length - 1].toUpperCase();

    const status = await getGameStatus(roomCode);
    if (!status) {
      peer.send(JSON.stringify({ event: "error", payload: { message: "Room not found" } }));
      peer.close();
      return;
    }

    // Store roomCode on the peer object for use in close handler
    (peer as any)._roomCode = roomCode;

    addConnection(roomCode, peer);

    // Send snapshot of current state to the newly connected client
    const snapshot = await getFullGameState(roomCode);
    peer.send(JSON.stringify({ event: "game:snapshot", payload: snapshot }));

    // Subscribe to Redis pub/sub for this room (one subscriber per connection)
    const subscriber = newRedisSubscriber();
    (peer as any)._subscriber = subscriber;

    await subscriber.subscribe(`game:${roomCode}:channel`);
    subscriber.on("message", (_channel: string, message: string) => {
      try {
        peer.send(message);
      } catch {
        // Connection closed
      }
    });
  },

  async message(peer, msg) {
    // Clients do not send messages over the WebSocket — all mutations go through API routes.
    // This handler exists only for keep-alive pings.
    const text = msg.text();
    if (text === "ping") peer.send("pong");
  },

  async close(peer) {
    const roomCode = (peer as any)._roomCode as string | undefined;
    const subscriber = (peer as any)._subscriber;

    if (subscriber) {
      subscriber.unsubscribe();
      subscriber.quit();
    }

    if (roomCode) {
      removeConnection(roomCode, peer);
      // Publish player:left only if we know who this was — requires playerId on peer
      const playerId = (peer as any)._playerId as string | undefined;
      if (playerId) {
        await removePlayerFromGame(roomCode, playerId);
        await publishEvent(roomCode, "player:left", { playerId });
      }
    }
  },
});
```

- [ ] **Step 2: Register the WS route in app.config.ts**

Open `app.config.ts` (generated by CLI). Add the WebSocket route to the Vinxi/Nitro config. The exact API depends on the generated config shape. Look for a `routers` or `nitro` config key:

```typescript
// app.config.ts (modify existing)
import { defineConfig } from "@tanstack/start/config";

export default defineConfig({
  // ... existing config ...
  server: {
    // Vinxi/Nitro automatically picks up files in src/routes/ws/ as WS handlers.
    // No extra registration needed if using the file-based routing convention.
  },
});
```

If the CLI version requires explicit registration, consult the TanStack Start docs for the `defineWebSocketHandler` mount path — the route file at `src/routes/ws/game/$code.ts` maps to `/_ws/game/:code`.

- [ ] **Step 3: Commit**

```bash
git add src/routes/ws/ app.config.ts
git commit -m "feat: add Vinxi WebSocket route for game rooms"
```

---

## Task 5: Create Game API route

**Files:**
- Create: `src/routes/api/games/index.ts`

- [ ] **Step 1: Write src/routes/api/games/index.ts**

```typescript
// src/routes/api/games/index.ts
import { json } from "@tanstack/start";
import { createAPIFileRoute } from "@tanstack/start/api";
import { z } from "zod";
import { db } from "../../../db/client";
import { gameSessions, gamePlayers } from "../../../db/schema";
import { generateRoomCode } from "../../../lib/room-code";
import { createGameState } from "../../../lib/game-state";
import { verifyToken } from "../../../lib/auth";
import { nanoid } from "nanoid";

const CreateGameBody = z.object({
  displayName: z.string().min(1).max(30),
  totalRounds: z.number().int().min(1).max(30).default(8),
  maxPlayers: z.number().int().min(2).max(20).default(10),
  packIds: z.array(z.number().int()).min(1),
  houseRules: z.object({
    randoCardrissian: z.boolean().default(false),
    happyEnding: z.boolean().default(false),
    packingHeat: z.boolean().default(false),
  }),
});

export const APIRoute = createAPIFileRoute("/api/games")({
  POST: async ({ request }) => {
    const body = await request.json();
    const parsed = CreateGameBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    // Resolve optional JWT
    const authHeader = request.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const jwtPayload = token ? await verifyToken(token) : null;

    const { displayName, totalRounds, maxPlayers, packIds, houseRules } = parsed.data;

    // Generate unique room code (retry up to 5 times on collision)
    let roomCode = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      roomCode = generateRoomCode();
      const existing = await db.query.gameSessions.findFirst({
        where: (s, { eq, and, notInArray }) =>
          and(eq(s.roomCode, roomCode), notInArray(s.status, ["ended"])),
      });
      if (!existing) break;
    }

    const config = { totalRounds, maxPlayers, packIds, houseRules };

    // Persist to PostgreSQL
    const [session] = await db
      .insert(gameSessions)
      .values({ roomCode, config, status: "waiting" })
      .returning();

    const playerId = nanoid();

    const [dbPlayer] = await db
      .insert(gamePlayers)
      .values({
        sessionId: session.id,
        userId: jwtPayload ? Number(jwtPayload.sub) : undefined,
        displayName,
        isHost: true,
        isSpectator: false,
      })
      .returning();

    // Create Redis state
    await createGameState(roomCode, config, {
      playerId: String(dbPlayer.id),
      name: displayName,
      userId: jwtPayload?.sub,
    });

    return json({ roomCode, playerId: String(dbPlayer.id) });
  },
});
```

- [ ] **Step 2: Install nanoid**

```bash
pnpm add nanoid
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/api/games/index.ts package.json pnpm-lock.yaml
git commit -m "feat: add POST /api/games — create game session"
```

---

## Task 6: Join Game API route

**Files:**
- Create: `src/routes/api/games/$code/join.ts`

- [ ] **Step 1: Write src/routes/api/games/$code/join.ts**

```typescript
// src/routes/api/games/$code/join.ts
import { json } from "@tanstack/start";
import { createAPIFileRoute } from "@tanstack/start/api";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../../../db/client";
import { gameSessions, gamePlayers } from "../../../../db/schema";
import {
  getGameStatus,
  addPlayerToGame,
  publishEvent,
} from "../../../../lib/game-state";
import { verifyToken } from "../../../../lib/auth";

const JoinBody = z.object({
  displayName: z.string().min(1).max(30),
  spectator: z.boolean().default(false),
});

export const APIRoute = createAPIFileRoute("/api/games/$code/join")({
  POST: async ({ request, params }) => {
    const roomCode = params.code.toUpperCase();
    const body = await request.json();
    const parsed = JoinBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const { displayName, spectator } = parsed.data;

    // Validate room exists and is joinable
    const status = await getGameStatus(roomCode);
    if (!status) {
      return json({ error: "Room not found" }, { status: 404 });
    }
    if (status === "ended") {
      return json({ error: "Game has already ended" }, { status: 410 });
    }

    // Only spectators can join mid-game without isPending;
    // players joining mid-game are marked isPending
    const isPending = status === "active" && !spectator;

    const authHeader = request.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const jwtPayload = token ? await verifyToken(token) : null;

    // Persist to PostgreSQL
    const [session] = await db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.roomCode, roomCode))
      .limit(1);

    const [dbPlayer] = await db
      .insert(gamePlayers)
      .values({
        sessionId: session.id,
        userId: jwtPayload ? Number(jwtPayload.sub) : undefined,
        displayName,
        isSpectator: spectator,
        isHost: false,
      })
      .returning();

    const playerId = String(dbPlayer.id);

    // Add to Redis
    await addPlayerToGame(roomCode, playerId, {
      name: displayName,
      userId: jwtPayload?.sub,
      score: 0,
      isHost: false,
      isSpectator: spectator,
      isPending,
    });

    // Fan out join event
    await publishEvent(roomCode, "player:joined", {
      playerId,
      name: displayName,
      isSpectator: spectator,
      isPending,
    });

    return json({ playerId, roomCode, isPending, status });
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/api/games/$code/join.ts
git commit -m "feat: add POST /api/games/:code/join"
```

---

## Task 7: Start Game API route

**Files:**
- Create: `src/routes/api/games/$code/start.ts`

- [ ] **Step 1: Write src/routes/api/games/$code/start.ts**

```typescript
// src/routes/api/games/$code/start.ts
// Validates host, player count, then sets status = "active" in Redis + Postgres.
// The game engine (Plan 4) handles round initialization triggered by this event.
import { json } from "@tanstack/start";
import { createAPIFileRoute } from "@tanstack/start/api";
import { eq } from "drizzle-orm";
import { db } from "../../../../db/client";
import { gameSessions } from "../../../../db/schema";
import {
  getGameStatus,
  getGamePlayers,
  publishEvent,
} from "../../../../lib/game-state";
import { getRedis } from "../../../../lib/redis";

export const APIRoute = createAPIFileRoute("/api/games/$code/start")({
  POST: async ({ request, params }) => {
    const roomCode = params.code.toUpperCase();

    const status = await getGameStatus(roomCode);
    if (!status) return json({ error: "Room not found" }, { status: 404 });
    if (status !== "waiting") {
      return json({ error: "Game already started" }, { status: 409 });
    }

    const body = await request.json().catch(() => ({}));
    const { playerId } = body as { playerId?: string };

    const players = await getGamePlayers(roomCode);
    const requestor = playerId ? players[playerId] : null;
    if (!requestor?.isHost) {
      return json({ error: "Only the host can start the game" }, { status: 403 });
    }

    const activePlayers = Object.values(players).filter(
      (p) => !p.isSpectator && !p.isPending
    );
    const config = JSON.parse(
      (await getRedis().hget(`game:${roomCode}`, "config")) ?? "{}"
    );
    const minPlayers = config.houseRules?.randoCardrissian ? 2 : 3;
    if (activePlayers.length < minPlayers) {
      return json(
        { error: `Need at least ${minPlayers} players to start` },
        { status: 422 }
      );
    }

    // Update Redis status
    const redis = getRedis();
    await redis
      .multi()
      .hset(`game:${roomCode}`, "status", "active")
      .exec();

    // Update PostgreSQL
    await db
      .update(gameSessions)
      .set({ status: "active", startedAt: new Date() })
      .where(eq(gameSessions.roomCode, roomCode));

    // Fan out — game engine (Plan 4) listens for this event to start round 1
    await publishEvent(roomCode, "game:started", { config });

    return json({ ok: true });
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/api/games/$code/start.ts
git commit -m "feat: add POST /api/games/:code/start"
```

---

## Task 8: useGameSocket React hook

**Files:**
- Create: `src/hooks/useGameSocket.ts`

- [ ] **Step 1: Write src/hooks/useGameSocket.ts**

```typescript
// src/hooks/useGameSocket.ts
import { useEffect, useRef, useState, useCallback } from "react";

export interface GameEvent {
  event: string;
  payload: unknown;
}

export function useGameSocket(roomCode: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<GameEvent | null>(null);
  const handlersRef = useRef<Map<string, (payload: unknown) => void>>(new Map());

  useEffect(() => {
    if (!roomCode) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/_ws/game/${roomCode}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      try {
        const msg: GameEvent = JSON.parse(e.data);
        setLastEvent(msg);
        handlersRef.current.get(msg.event)?.(msg.payload);
        handlersRef.current.get("*")?.(msg);
      } catch {
        // ignore non-JSON
      }
    };

    const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30000);

    return () => {
      clearInterval(ping);
      ws.close();
    };
  }, [roomCode]);

  const on = useCallback((event: string, handler: (payload: unknown) => void) => {
    handlersRef.current.set(event, handler);
  }, []);

  return { connected, lastEvent, on };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useGameSocket.ts
git commit -m "feat: add useGameSocket React hook"
```

---

## Task 9: Create Game screen

**Files:**
- Create: `src/routes/games/create.tsx`

- [ ] **Step 1: Write src/routes/games/create.tsx**

```typescript
// src/routes/games/create.tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "../../contexts/AuthContext";

export const Route = createFileRoute("/games/create")({
  component: CreateGameScreen,
});

const DEFAULT_PACK_IDS = [1]; // Pack IDs are loaded from API in a real implementation.
// For now we default to pack 1 (the base pack). The full pack picker is in Plan 5.

function CreateGameScreen() {
  const { user, token } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(user?.username ?? "");
  const [totalRounds, setTotalRounds] = useState(8);
  const [maxPlayers, setMaxPlayers] = useState(10);
  const [randoCardrissian, setRandoCardrissian] = useState(false);
  const [happyEnding, setHappyEnding] = useState(false);
  const [packingHeat, setPackingHeat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/games", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          displayName,
          totalRounds,
          maxPlayers,
          packIds: DEFAULT_PACK_IDS,
          houseRules: { randoCardrissian, happyEnding, packingHeat },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create game");
        return;
      }
      navigate({ to: `/games/${data.roomCode}/lobby`, search: { playerId: data.playerId } });
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    "w-full bg-[#1e293b] border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500";
  const labelCls = "block text-xs text-slate-400 mb-1 uppercase tracking-widest";

  return (
    <div className="min-h-screen flex items-center justify-center px-4"
         style={{ background: "linear-gradient(135deg, #1a0533 0%, #0d1a33 100%)" }}>
      <div className="w-full max-w-md bg-[#0d0d1a] border border-purple-900/30 rounded-2xl p-8 shadow-2xl">
        <h2 className="text-center font-black text-xl text-white mb-6">Create Game</h2>

        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <div>
            <label className={labelCls}>Your display name</label>
            <input className={inputCls} value={displayName}
                   onChange={(e) => setDisplayName(e.target.value)} required />
          </div>
          <div className="flex gap-4">
            <div className="flex-1">
              <label className={labelCls}>Rounds</label>
              <input type="number" className={inputCls} min={1} max={30}
                     value={totalRounds} onChange={(e) => setTotalRounds(Number(e.target.value))} />
            </div>
            <div className="flex-1">
              <label className={labelCls}>Max players</label>
              <input type="number" className={inputCls} min={2} max={20}
                     value={maxPlayers} onChange={(e) => setMaxPlayers(Number(e.target.value))} />
            </div>
          </div>

          <div>
            <p className={labelCls}>House rules</p>
            {[
              { key: "randoCardrissian", label: "Rando Cardrissian", val: randoCardrissian, set: setRandoCardrissian },
              { key: "happyEnding", label: "Happy Ending", val: happyEnding, set: setHappyEnding },
              { key: "packingHeat", label: "Packing Heat", val: packingHeat, set: setPackingHeat },
            ].map(({ key, label, val, set }) => (
              <label key={key} className="flex items-center gap-2 text-sm text-slate-300 mb-2 cursor-pointer">
                <input type="checkbox" checked={val} onChange={(e) => set(e.target.checked)}
                       className="accent-purple-500" />
                {label}
              </label>
            ))}
          </div>

          {error && <p className="text-red-400 text-sm text-center">{error}</p>}

          <button type="submit" disabled={loading}
                  className="py-2 rounded-xl font-bold text-white text-sm disabled:opacity-50"
                  style={{ background: "linear-gradient(90deg, #7c3aed, #ec4899)" }}>
            {loading ? "Creating…" : "Create Game"}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/games/create.tsx
git commit -m "feat: add Create Game screen"
```

---

## Task 10: Join Game screen

**Files:**
- Create: `src/routes/games/join.tsx`

- [ ] **Step 1: Write src/routes/games/join.tsx**

```typescript
// src/routes/games/join.tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "../../contexts/AuthContext";

export const Route = createFileRoute("/games/join")({
  component: JoinGameScreen,
});

function JoinGameScreen() {
  const { user, token } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(user?.username ?? "");
  const [roomCode, setRoomCode] = useState("");
  const [asSpectator, setAsSpectator] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const code = roomCode.trim().toUpperCase();
    try {
      const res = await fetch(`/api/games/${code}/join`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ displayName, spectator: asSpectator }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not join game");
        return;
      }
      // Redirect to lobby (or game screen if already active)
      if (data.status === "active") {
        navigate({ to: `/games/${code}/session`, search: { playerId: data.playerId } });
      } else {
        navigate({ to: `/games/${code}/lobby`, search: { playerId: data.playerId } });
      }
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    "w-full bg-[#1e293b] border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500";

  return (
    <div className="min-h-screen flex items-center justify-center px-4"
         style={{ background: "linear-gradient(135deg, #1a0533 0%, #0d1a33 100%)" }}>
      <div className="w-full max-w-sm bg-[#0d0d1a] border border-purple-900/30 rounded-2xl p-8 shadow-2xl">
        <h2 className="text-center font-black text-xl text-white mb-6">Join Game</h2>

        <form onSubmit={handleJoin} className="flex flex-col gap-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1 uppercase tracking-widest">
              Display name
            </label>
            <input className={inputCls} value={displayName}
                   onChange={(e) => setDisplayName(e.target.value)} required />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1 uppercase tracking-widest">
              Room code
            </label>
            <input
              className={`${inputCls} text-2xl font-black tracking-widest text-center uppercase`}
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="XXXXXX"
              required
            />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-2 uppercase tracking-widest">
              Join as
            </label>
            <div className="flex bg-[#1e293b] rounded-lg p-1 gap-1">
              {(["Player", "Spectator"] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  onClick={() => setAsSpectator(mode === "Spectator")}
                  className={`flex-1 py-1.5 rounded-md text-sm font-semibold transition-colors ${
                    (mode === "Spectator") === asSpectator
                      ? "bg-purple-600 text-white"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-red-400 text-sm text-center">{error}</p>}

          <button type="submit" disabled={loading}
                  className="py-2 rounded-xl font-bold text-white text-sm disabled:opacity-50"
                  style={{ background: "linear-gradient(90deg, #7c3aed, #ec4899)" }}>
            {loading ? "Joining…" : "Join Game"}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/games/join.tsx
git commit -m "feat: add Join Game screen"
```

---

## Task 11: Lobby screen

**Files:**
- Create: `src/routes/games/$code/lobby.tsx`

- [ ] **Step 1: Write src/routes/games/$code/lobby.tsx**

```typescript
// src/routes/games/$code/lobby.tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useGameSocket } from "../../../hooks/useGameSocket";

export const Route = createFileRoute("/games/$code/lobby")({
  validateSearch: (s: Record<string, unknown>) => ({ playerId: String(s.playerId ?? "") }),
  component: LobbyScreen,
});

function LobbyScreen() {
  const { code } = Route.useParams();
  const { playerId } = Route.useSearch();
  const navigate = useNavigate();
  const { connected, on } = useGameSocket(code);
  const [players, setPlayers] = useState<Array<{ id: string; name: string; isHost: boolean; isSpectator: boolean }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load initial player list from the snapshot
  on("game:snapshot", (payload: any) => {
    if (!payload?.players) return;
    setPlayers(
      Object.entries(payload.players).map(([id, p]: [string, any]) => ({
        id,
        name: p.name,
        isHost: p.isHost,
        isSpectator: p.isSpectator,
      }))
    );
  });

  on("player:joined", (payload: any) => {
    setPlayers((prev) => {
      if (prev.some((p) => p.id === payload.playerId)) return prev;
      return [...prev, { id: payload.playerId, name: payload.name, isHost: false, isSpectator: payload.isSpectator }];
    });
  });

  on("player:left", (payload: any) => {
    setPlayers((prev) => prev.filter((p) => p.id !== payload.playerId));
  });

  on("game:started", () => {
    navigate({ to: `/games/${code}/session`, search: { playerId } });
  });

  const me = players.find((p) => p.id === playerId);
  const activePlayers = players.filter((p) => !p.isSpectator);
  const spectators = players.filter((p) => p.isSpectator);

  async function handleStart() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/games/${code}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "Failed to start");
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4"
         style={{ background: "linear-gradient(135deg, #1a0533 0%, #0d1a33 100%)" }}>
      <div className="w-full max-w-md">
        {/* Room code */}
        <div className="text-center mb-8">
          <p className="text-slate-400 text-xs uppercase tracking-widest mb-1">Room code</p>
          <p className="font-black text-5xl tracking-widest"
             style={{ background: "linear-gradient(90deg, #f97316, #ec4899, #a855f7)",
                      WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            {code}
          </p>
        </div>

        {/* Players */}
        <div className="bg-[#0d0d1a] border border-purple-900/30 rounded-2xl p-6 mb-4">
          <p className="text-xs text-slate-500 uppercase tracking-widest mb-3">
            Players ({activePlayers.length})
          </p>
          <ul className="flex flex-col gap-2">
            {activePlayers.map((p) => (
              <li key={p.id}
                  className="flex items-center justify-between py-2 px-3 rounded-lg bg-[#1e293b]">
                <span className="text-sm font-semibold text-white">{p.name}</span>
                <span className="flex gap-1.5">
                  {p.isHost && (
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full"
                          style={{ background: "linear-gradient(90deg,#f97316,#ec4899)", color: "#fff" }}>
                      HOST
                    </span>
                  )}
                  {p.id === playerId && (
                    <span className="text-xs font-bold text-purple-400">You</span>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {spectators.length > 0 && (
            <>
              <p className="text-xs text-slate-500 uppercase tracking-widest mt-4 mb-2">
                Watching ({spectators.length})
              </p>
              <ul className="flex flex-col gap-1">
                {spectators.map((p) => (
                  <li key={p.id} className="text-sm text-slate-400 px-3 py-1">
                    {p.name}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {/* Actions */}
        {error && <p className="text-red-400 text-sm text-center mb-2">{error}</p>}
        {me?.isHost ? (
          <button onClick={handleStart} disabled={loading || activePlayers.length < 3}
                  className="w-full py-3 rounded-xl font-bold text-white text-sm disabled:opacity-40"
                  style={{ background: "linear-gradient(90deg, #7c3aed, #ec4899)" }}>
            {loading ? "Starting…" : `Start Game (${activePlayers.length}/3 min)`}
          </button>
        ) : (
          <p className="text-center text-slate-400 text-sm">Waiting for host to start…</p>
        )}

        {!connected && (
          <p className="text-center text-yellow-500 text-xs mt-3">Reconnecting…</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/games/$code/lobby.tsx
git commit -m "feat: add Lobby screen with real-time WebSocket player list"
```

---

## Verification

End-to-end check for Plan 3:

1. Open two browser tabs — Tab A creates a game → lands in Lobby, room code shown
2. Tab B opens `/games/join`, enters room code → both tabs show each other in the player list in real time
3. Third tab joins as spectator → appears in "Watching" section, not players
4. Host clicks "Start Game" (with ≥ 3 players) → all tabs receive `game:started`, redirect to `/games/:code/session`
5. `pnpm test src/lib/room-code.test.ts src/lib/game-state.test.ts` — all tests pass

If all 5 pass, Plan 3 is complete. Proceed to Plan 4 (Game Engine).
