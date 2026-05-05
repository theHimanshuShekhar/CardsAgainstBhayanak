# CardsAgainstBhayanak — Plan 2: Auth & User Profiles

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement optional user registration and sign-in (username + passphrase, no email). Issue JWTs stored in localStorage. Expose a stats API endpoint. Build the Auth screen (Sign In / Register tabs) and make the Home screen JWT-aware.

**Architecture:** Server-side: two TanStack Start API route handlers (`/api/auth/register`, `/api/auth/login`) plus a stats route (`/api/users/:username/stats`). Passwords hashed with bcryptjs. JWTs signed with `jose` (HS256, 7-day expiry). Client-side: React context reads JWT from localStorage, provides `currentUser` across the app. Auth screen is a tabbed form (Sign In / Register). Home screen shows "Signed in as @username" when JWT is present.

**Tech Stack:** TanStack Start API routes, bcryptjs, jose, Drizzle ORM (users + game_players tables), Vitest, React context

**Prerequisite:** Plan 1 complete — database running, schema pushed, `src/db/client.ts` and `src/db/schema.ts` exist.

---

## File Map

| File | Purpose |
|---|---|
| `src/lib/auth.ts` | JWT sign / verify helpers |
| `src/lib/password.ts` | bcrypt hash / compare helpers |
| `src/routes/api/auth/register.ts` | POST /api/auth/register |
| `src/routes/api/auth/login.ts` | POST /api/auth/login |
| `src/routes/api/users/$username/stats.ts` | GET /api/users/:username/stats |
| `src/contexts/AuthContext.tsx` | React context — currentUser, login, logout |
| `src/routes/__root.tsx` | Wrap app with AuthProvider (modify existing) |
| `src/routes/index.tsx` | Home screen — shows signed-in state (modify existing) |
| `src/routes/auth.tsx` | Sign In / Register tabbed screen |
| `src/lib/auth.test.ts` | Vitest: JWT sign/verify round-trip |
| `src/routes/api/auth/register.test.ts` | Vitest: register + duplicate username |
| `src/routes/api/auth/login.test.ts` | Vitest: login success + wrong passphrase |

---

## Task 1: JWT and password helpers

**Files:**
- Create: `src/lib/auth.ts`
- Create: `src/lib/password.ts`

- [ ] **Step 1: Write src/lib/password.ts**

```typescript
// src/lib/password.ts
import bcrypt from "bcryptjs";

export async function hashPassphrase(passphrase: string): Promise<string> {
  return bcrypt.hash(passphrase, 12);
}

export async function verifyPassphrase(
  passphrase: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(passphrase, hash);
}
```

- [ ] **Step 2: Write src/lib/auth.ts**

```typescript
// src/lib/auth.ts
import { SignJWT, jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "dev_secret_change_in_production"
);

export interface JwtPayload {
  sub: string;       // user id (string)
  username: string;
}

export async function signToken(payload: JwtPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(SECRET);
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Write src/lib/auth.test.ts**

```typescript
// src/lib/auth.test.ts
import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "./auth";

describe("JWT helpers", () => {
  it("signs and verifies a token round-trip", async () => {
    const token = await signToken({ sub: "42", username: "testuser" });
    const payload = await verifyToken(token);
    expect(payload?.sub).toBe("42");
    expect(payload?.username).toBe("testuser");
  });

  it("returns null for an invalid token", async () => {
    const result = await verifyToken("not.a.token");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/lib/auth.test.ts
```

Expected:
```
✓ src/lib/auth.test.ts (2)
  ✓ JWT helpers > signs and verifies a token round-trip
  ✓ JWT helpers > returns null for an invalid token
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth.ts src/lib/password.ts src/lib/auth.test.ts
git commit -m "feat: add JWT sign/verify and bcrypt passphrase helpers"
```

---

## Task 2: Register API route

**Files:**
- Create: `src/routes/api/auth/register.ts`
- Create: `src/routes/api/auth/register.test.ts`

- [ ] **Step 1: Write src/routes/api/auth/register.ts**

```typescript
// src/routes/api/auth/register.ts
import { json } from "@tanstack/start";
import { createAPIFileRoute } from "@tanstack/start/api";
import { z } from "zod";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { hashPassphrase } from "../../../lib/password";
import { signToken } from "../../../lib/auth";

const RegisterBody = z.object({
  username: z
    .string()
    .min(2)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/, "Username may only contain letters, numbers, and underscores"),
  passphrase: z.string().min(6).max(128),
});

export const APIRoute = createAPIFileRoute("/api/auth/register")({
  POST: async ({ request }) => {
    const body = await request.json();
    const parsed = RegisterBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const { username, passphrase } = parsed.data;
    const passphraseHash = await hashPassphrase(passphrase);

    try {
      const [user] = await db
        .insert(users)
        .values({ username, passphraseHash })
        .returning();

      const token = await signToken({ sub: String(user.id), username: user.username });
      return json({ token, username: user.username });
    } catch (err: any) {
      if (err.code === "23505") {
        return json({ error: "Username already taken" }, { status: 409 });
      }
      throw err;
    }
  },
});
```

- [ ] **Step 2: Write src/routes/api/auth/register.test.ts**

```typescript
// src/routes/api/auth/register.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { hashPassphrase } from "../../../lib/password";
import { signToken } from "../../../lib/auth";

const TEST_USERNAME = "__vitest_reg_user__";

afterAll(async () => {
  await db.delete(users).where(eq(users.username, TEST_USERNAME));
});

describe("register logic", () => {
  it("creates a user and returns a signed token", async () => {
    const hash = await hashPassphrase("supersecret");
    const [user] = await db
      .insert(users)
      .values({ username: TEST_USERNAME, passphraseHash: hash })
      .returning();

    expect(user.id).toBeGreaterThan(0);
    expect(user.username).toBe(TEST_USERNAME);

    const token = await signToken({ sub: String(user.id), username: user.username });
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
  });

  it("rejects a duplicate username (unique constraint)", async () => {
    const hash = await hashPassphrase("another");
    await expect(
      db.insert(users).values({ username: TEST_USERNAME, passphraseHash: hash })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm test src/routes/api/auth/register.test.ts
```

Expected:
```
✓ src/routes/api/auth/register.test.ts (2)
  ✓ register logic > creates a user and returns a signed token
  ✓ register logic > rejects a duplicate username (unique constraint)
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/api/auth/register.ts src/routes/api/auth/register.test.ts
git commit -m "feat: add POST /api/auth/register endpoint"
```

---

## Task 3: Login API route

**Files:**
- Create: `src/routes/api/auth/login.ts`
- Create: `src/routes/api/auth/login.test.ts`

- [ ] **Step 1: Write src/routes/api/auth/login.ts**

```typescript
// src/routes/api/auth/login.ts
import { json } from "@tanstack/start";
import { createAPIFileRoute } from "@tanstack/start/api";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { verifyPassphrase } from "../../../lib/password";
import { signToken } from "../../../lib/auth";

const LoginBody = z.object({
  username: z.string().min(1),
  passphrase: z.string().min(1),
});

export const APIRoute = createAPIFileRoute("/api/auth/login")({
  POST: async ({ request }) => {
    const body = await request.json();
    const parsed = LoginBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Missing username or passphrase" }, { status: 400 });
    }

    const { username, passphrase } = parsed.data;
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (!user) {
      return json({ error: "Invalid username or passphrase" }, { status: 401 });
    }

    const valid = await verifyPassphrase(passphrase, user.passphraseHash);
    if (!valid) {
      return json({ error: "Invalid username or passphrase" }, { status: 401 });
    }

    const token = await signToken({ sub: String(user.id), username: user.username });
    return json({ token, username: user.username });
  },
});
```

- [ ] **Step 2: Write src/routes/api/auth/login.test.ts**

```typescript
// src/routes/api/auth/login.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { hashPassphrase, verifyPassphrase } from "../../../lib/password";

const TEST_USERNAME = "__vitest_login_user__";
const TEST_PASSPHRASE = "correcthorsebatterystaple";

beforeAll(async () => {
  const hash = await hashPassphrase(TEST_PASSPHRASE);
  await db.insert(users).values({ username: TEST_USERNAME, passphraseHash: hash });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.username, TEST_USERNAME));
});

describe("login logic", () => {
  it("returns true for the correct passphrase", async () => {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, TEST_USERNAME))
      .limit(1);
    const ok = await verifyPassphrase(TEST_PASSPHRASE, user.passphraseHash);
    expect(ok).toBe(true);
  });

  it("returns false for a wrong passphrase", async () => {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, TEST_USERNAME))
      .limit(1);
    const ok = await verifyPassphrase("wrongpassphrase", user.passphraseHash);
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm test src/routes/api/auth/login.test.ts
```

Expected:
```
✓ src/routes/api/auth/login.test.ts (2)
  ✓ login logic > returns true for the correct passphrase
  ✓ login logic > returns false for a wrong passphrase
```

- [ ] **Step 4: Commit**

```bash
git add src/routes/api/auth/login.ts src/routes/api/auth/login.test.ts
git commit -m "feat: add POST /api/auth/login endpoint"
```

---

## Task 4: User stats API route

**Files:**
- Create: `src/routes/api/users/$username/stats.ts`

- [ ] **Step 1: Write src/routes/api/users/$username/stats.ts**

```typescript
// src/routes/api/users/$username/stats.ts
import { json } from "@tanstack/start";
import { createAPIFileRoute } from "@tanstack/start/api";
import { eq, and, max, sum, count } from "drizzle-orm";
import { db } from "../../../../db/client";
import { users, gamePlayers, gameSessions } from "../../../../db/schema";

export const APIRoute = createAPIFileRoute("/api/users/$username/stats")({
  GET: async ({ params }) => {
    const { username } = params;

    const [user] = await db
      .select({ id: users.id, username: users.username, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (!user) {
      return json({ error: "User not found" }, { status: 404 });
    }

    const sessions = await db
      .select({
        sessionId: gamePlayers.sessionId,
        finalScore: gamePlayers.finalScore,
        status: gameSessions.status,
        endedAt: gameSessions.endedAt,
      })
      .from(gamePlayers)
      .innerJoin(gameSessions, eq(gamePlayers.sessionId, gameSessions.id))
      .where(
        and(
          eq(gamePlayers.userId, user.id),
          eq(gamePlayers.isSpectator, false)
        )
      )
      .orderBy(gameSessions.endedAt)
      .limit(50);

    const completedSessions = sessions.filter((s) => s.status === "ended");
    const gamesPlayed = completedSessions.length;
    const totalPoints = completedSessions.reduce(
      (acc, s) => acc + (s.finalScore ?? 0),
      0
    );
    const bestScore = completedSessions.reduce(
      (acc, s) => Math.max(acc, s.finalScore ?? 0),
      0
    );

    // A "win" is the player with the highest score in a session.
    // The winner is computed client-side per session from game_rounds,
    // but here we approximate: top scorer in completed sessions (tracked in game_players).
    // Full winner tracking is in game_rounds (winner_player_id). For stats page,
    // we expose raw data so the UI can compute wins if needed.

    return json({
      username: user.username,
      createdAt: user.createdAt,
      gamesPlayed,
      totalPoints,
      bestScore,
      recentSessions: completedSessions.slice(-50).map((s) => ({
        sessionId: s.sessionId,
        finalScore: s.finalScore,
        endedAt: s.endedAt,
      })),
    });
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/api/users/
git commit -m "feat: add GET /api/users/:username/stats endpoint"
```

---

## Task 5: React AuthContext

**Files:**
- Create: `src/contexts/AuthContext.tsx`
- Modify: `src/routes/__root.tsx`

- [ ] **Step 1: Write src/contexts/AuthContext.tsx**

```typescript
// src/contexts/AuthContext.tsx
import React, { createContext, useContext, useState, useEffect } from "react";
import { verifyToken } from "../lib/auth";

interface AuthUser {
  id: string;
  username: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  login: (token: string, username: string, id: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  token: null,
  login: () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("cab_token");
    if (!stored) return;
    // Verify token on mount (client-side check — exp field)
    verifyToken(stored).then((payload) => {
      if (payload) {
        setToken(stored);
        setUser({ id: payload.sub, username: payload.username });
      } else {
        localStorage.removeItem("cab_token");
      }
    });
  }, []);

  function login(newToken: string, username: string, id: string) {
    localStorage.setItem("cab_token", newToken);
    setToken(newToken);
    setUser({ id, username });
  }

  function logout() {
    localStorage.removeItem("cab_token");
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
```

- [ ] **Step 2: Wrap app with AuthProvider in __root.tsx**

Open `src/routes/__root.tsx`. Find the root component's return (or `Outlet`) and wrap it with `<AuthProvider>`:

```typescript
// src/routes/__root.tsx  (modify existing)
import { AuthProvider } from "../contexts/AuthContext";

// Inside the root component JSX, wrap the existing content:
// Before:
//   <Outlet />
// After:
//   <AuthProvider>
//     <Outlet />
//   </AuthProvider>
```

The exact pattern depends on what the CLI generated. Find the `createRootRoute` call and add `<AuthProvider>` around `<Outlet />`.

- [ ] **Step 3: Commit**

```bash
git add src/contexts/AuthContext.tsx src/routes/__root.tsx
git commit -m "feat: add AuthContext — JWT-backed user state"
```

---

## Task 6: Auth screen (Sign In / Register)

**Files:**
- Create: `src/routes/auth.tsx`

- [ ] **Step 1: Write src/routes/auth.tsx**

```typescript
// src/routes/auth.tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";

export const Route = createFileRoute("/auth")({
  component: AuthScreen,
});

function AuthScreen() {
  const [tab, setTab] = useState<"signin" | "register">("signin");
  const [username, setUsername] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const endpoint =
        tab === "register" ? "/api/auth/register" : "/api/auth/login";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, passphrase }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        return;
      }
      login(data.token, data.username, "");
      navigate({ to: "/" });
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center"
         style={{ background: "linear-gradient(135deg, #1a0533 0%, #0d1a33 100%)" }}>
      <div className="w-full max-w-sm bg-[#0d0d1a] border border-purple-900/30 rounded-2xl p-8 shadow-2xl">
        {/* Logo */}
        <h1 className="text-center font-black text-2xl mb-6"
            style={{ background: "linear-gradient(90deg, #f97316, #ec4899, #a855f7)",
                     WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          CardsAgainstBhayanak
        </h1>

        {/* Tabs */}
        <div className="flex mb-6 bg-[#1e293b] rounded-lg p-1">
          {(["signin", "register"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setError(null); }}
              className={`flex-1 py-1.5 rounded-md text-sm font-semibold transition-colors ${
                tab === t
                  ? "bg-purple-600 text-white"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {t === "signin" ? "Sign In" : "Register"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1 uppercase tracking-widest">
              Username
            </label>
            <input
              className="w-full bg-[#1e293b] border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your_username"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1 uppercase tracking-widest">
              Passphrase
            </label>
            <input
              type="password"
              className="w-full bg-[#1e293b] border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="at least 6 characters"
              required
            />
          </div>
          {error && (
            <p className="text-red-400 text-sm text-center">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 rounded-lg font-bold text-sm text-white transition-opacity disabled:opacity-50"
            style={{ background: "linear-gradient(90deg, #7c3aed, #ec4899)" }}
          >
            {loading ? "…" : tab === "signin" ? "Sign In" : "Create Account"}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/auth.tsx
git commit -m "feat: add Sign In / Register auth screen"
```

---

## Task 7: Home screen — JWT-aware

**Files:**
- Modify: `src/routes/index.tsx`

- [ ] **Step 1: Replace the generated Home screen with the CAB Home screen**

```typescript
// src/routes/index.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAuth } from "../contexts/AuthContext";

export const Route = createFileRoute("/")({
  component: HomeScreen,
});

function HomeScreen() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 px-4"
         style={{ background: "linear-gradient(135deg, #1a0533 0%, #0d1a33 100%)" }}>

      {/* Logo */}
      <h1 className="font-black text-4xl sm:text-5xl text-center"
          style={{ background: "linear-gradient(90deg, #f97316, #ec4899, #a855f7)",
                   WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
        Cards Against Bhayanak
      </h1>

      {/* Auth status */}
      {user ? (
        <p className="text-slate-400 text-sm">
          Signed in as{" "}
          <span className="text-purple-400 font-semibold">@{user.username}</span>
          {" · "}
          <button onClick={logout} className="text-slate-500 underline hover:text-white">
            sign out
          </button>
        </p>
      ) : (
        <p className="text-slate-500 text-sm">Playing as guest</p>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-3 w-full max-w-xs">
        <Link
          to="/games/create"
          className="block text-center py-3 rounded-xl font-bold text-white text-sm"
          style={{ background: "linear-gradient(90deg, #7c3aed, #ec4899)" }}
        >
          Create Game
        </Link>
        <Link
          to="/games/join"
          className="block text-center py-3 rounded-xl font-bold text-white text-sm border border-purple-600/40 hover:border-purple-500"
        >
          Join Game
        </Link>
        {!user && (
          <Link
            to="/auth"
            className="block text-center py-3 rounded-xl font-bold text-sm text-purple-400 hover:text-white"
          >
            Sign In / Register
          </Link>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Start dev server and verify**

```bash
pnpm dev
```

Open `http://localhost:3000`. Expected:
- Gradient background, logo, three buttons (Create Game, Join Game, Sign In / Register)
- Navigate to `/auth` — tabbed form renders, Sign In tab and Register tab switch
- Register a new user — JWT stored in localStorage, redirected to Home
- Home shows "Signed in as @username" with sign-out link
- Sign out — user state cleared, Sign In / Register link reappears

- [ ] **Step 3: Commit**

```bash
git add src/routes/index.tsx
git commit -m "feat: update Home screen with JWT-aware auth state"
```

---

## Verification

End-to-end check for Plan 2:

1. `pnpm test` — all auth tests pass
2. `pnpm dev` → register a new user via `/auth` → JWT appears in `localStorage` under `cab_token`
3. Hard-refresh the page → still signed in (AuthContext reads JWT on mount)
4. Sign out → `cab_token` removed from `localStorage`, home shows guest state
5. `GET /api/users/<username>/stats` returns `{ gamesPlayed: 0, totalPoints: 0 }`

If all 5 pass, Plan 2 is complete. Proceed to Plan 3 (Game Sessions, Lobby, WebSocket).
