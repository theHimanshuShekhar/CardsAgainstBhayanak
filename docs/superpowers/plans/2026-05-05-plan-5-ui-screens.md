# CardsAgainstBhayanak — Plan 5: All UI Screens & Responsive Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build all remaining screens — the full Game Session screen (real-time play), Round Result overlay, End Screen/Final Scoreboard, and a polished pack-picker in Create Game — with the exact visual design from the approved spec: vibrant dark gradient chrome, physical CAH card proportions, responsive desktop/mobile layouts, hidden-scrollbar hand row with gradient fade + animated chevron, and CSS-grid submitted answers that wrap to new rows.

**Architecture:** All screens are TanStack Start file-based routes under `src/routes/`. Shared card components live in `src/components/`. Responsive layout uses Tailwind breakpoints (`sm`, `md`, `lg`). The Game Session screen subscribes to WebSocket events via `useGameSocket` (Plan 3) and calls API routes for card play and Czar pick. shadcn/ui provides base primitives (dialog, badge, progress) where useful.

**Tech Stack:** TanStack Start routes, TailwindCSS, shadcn/ui, `useGameSocket` hook (Plan 3), Vitest

**Prerequisite:** Plans 1–4 complete — full game engine working, WebSocket infrastructure live.

---

## File Map

| File | Purpose |
|---|---|
| `src/components/CahCard.tsx` | Reusable black/white card component — correct proportions, logo, pick badge |
| `src/components/Scoreboard.tsx` | Player list with scores, Czar badge, played/waiting indicator, progress bar |
| `src/components/HandScroll.tsx` | Horizontal scrollable hand — hidden scrollbar, gradient fade, animated chevron |
| `src/components/SubmittedAnswers.tsx` | CSS-grid submitted answer cards — wraps to new rows, Czar pick interaction |
| `src/routes/games/$code/session.tsx` | Full Game Session screen — top bar, black card + scoreboard row, answers, hand |
| `src/routes/games/$code/result.tsx` | Round Result overlay — winner highlight, auto-advance countdown |
| `src/routes/games/$code/end.tsx` | End Screen / Final Scoreboard — winner crowned, Play Again button |
| `src/routes/games/create.tsx` | Update Create Game — add full pack picker chip list (modify existing) |
| `tailwind.config.ts` | Ensure custom colours are available (modify or verify existing) |

---

## Task 1: Install shadcn/ui

**Files:**
- Modify: (shadcn scaffolding — generates `src/components/ui/` tree)

- [ ] **Step 1: Initialise shadcn/ui via CLI**

```bash
pnpm dlx shadcn@latest init -t vite
```

When prompted:
- Style: **Default**
- Base color: **Slate**
- CSS variables: **yes**

- [ ] **Step 2: Add the components we need**

```bash
pnpm dlx shadcn@latest add badge progress dialog
```

- [ ] **Step 3: Commit scaffolded UI**

```bash
git add src/components/ui/ components.json tailwind.config.ts src/index.css
git commit -m "chore: initialise shadcn/ui with badge, progress, dialog"
```

---

## Task 2: Shared card component

**Files:**
- Create: `src/components/CahCard.tsx`

The card always matches the physical CAH layout:
- Portrait orientation
- Text top-left, bold sans-serif
- Logo bottom-left (small gradient "C" icon + "Cards Against Bhayanak" text)
- "Pick X" bottom-right (black cards only)
- Black card: black background, white text
- White card: white background, black text

- [ ] **Step 1: Write src/components/CahCard.tsx**

```typescript
// src/components/CahCard.tsx
import React from "react";

interface CahCardProps {
  variant: "black" | "white";
  text: string;
  pick?: number;           // black cards only
  size?: "full" | "hand"; // full = ~170×238px desktop; hand = ~90×126px desktop
  played?: boolean;        // white: green glow + dimmed
  selected?: boolean;      // white (Czar): purple glow
  onClick?: () => void;
  placeholder?: string;    // shown when text is empty (e.g. "Dev thinking…")
  className?: string;
}

const LOGO = (
  <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
    <div
      style={{
        width: 11, height: 11, borderRadius: 2,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontWeight: 900, fontSize: 6,
      }}
    >
      C
    </div>
    <span style={{ fontWeight: 700, fontSize: 6, letterSpacing: 0.2, lineHeight: 1.2 }}>
      Cards Against<br />Bhayanak
    </span>
  </div>
);

export function CahCard({
  variant,
  text,
  pick,
  size = "full",
  played = false,
  selected = false,
  onClick,
  placeholder,
  className = "",
}: CahCardProps) {
  const isBlack = variant === "black";
  const isFull = size === "full";

  const w = isFull ? "170px" : "90px";
  const minH = isFull ? "238px" : "126px";
  const fontSize = isFull ? (text.length > 80 ? 12 : 15) : (text.length > 60 ? 8 : 10);
  const padding = isFull ? "16px 14px 12px" : "10px 9px 8px";

  let boxShadow = isBlack
    ? "0 8px 24px rgba(0,0,0,0.8)"
    : "0 4px 14px rgba(0,0,0,0.35)";
  if (played) boxShadow = "0 0 0 2.5px #34d399, 0 4px 14px rgba(52,211,153,0.2)";
  if (selected) boxShadow = "0 0 0 2.5px #a855f7, 0 4px 16px rgba(168,85,247,0.35)";

  const bgColor = isBlack ? "#000" : "#fff";
  const textColor = isBlack ? "#fff" : "#000";
  const logoColor = isBlack ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.28)";
  const logoBg = isBlack ? "#fff" : "#000";
  const logoText = isBlack ? "#000" : "#fff";

  const interactive = !!onClick && !played;

  return (
    <div
      onClick={interactive ? onClick : undefined}
      className={className}
      style={{
        width: w,
        minHeight: minH,
        padding,
        borderRadius: 10,
        background: bgColor,
        color: textColor,
        boxShadow,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
        fontWeight: 800,
        lineHeight: 1.35,
        fontSize,
        flexShrink: 0,
        cursor: interactive ? "pointer" : "default",
        opacity: played ? 0.55 : 1,
        transition: "transform 0.1s, box-shadow 0.1s",
        userSelect: "none",
      }}
      onMouseEnter={(e) => {
        if (interactive) (e.currentTarget as HTMLElement).style.transform = "translateY(-3px)";
      }}
      onMouseLeave={(e) => {
        if (interactive) (e.currentTarget as HTMLElement).style.transform = "";
      }}
    >
      {/* Card text */}
      <div>
        {placeholder && !text ? (
          <span style={{ color: "#94a3b8", fontStyle: "italic", fontWeight: 600, fontSize: 9 }}>
            {placeholder}
          </span>
        ) : (
          text
        )}
      </div>

      {/* Footer */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <div
            style={{
              width: isFull ? 13 : 10, height: isFull ? 13 : 10,
              borderRadius: 2, background: logoBg, color: logoText,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontWeight: 900, fontSize: isFull ? 7 : 6,
            }}
          >
            C
          </div>
          <span style={{ fontWeight: 700, fontSize: isFull ? 6 : 5.5, letterSpacing: 0.2, lineHeight: 1.2, color: logoColor }}>
            Cards Against<br />Bhayanak
          </span>
        </div>
        {isBlack && pick && (
          <span style={{ fontSize: isFull ? 8 : 6.5, fontWeight: 900, textTransform: "uppercase", color: "rgba(255,255,255,0.4)" }}>
            Pick {pick}
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/CahCard.tsx
git commit -m "feat: add CahCard component — black and white variants"
```

---

## Task 3: Scoreboard component

**Files:**
- Create: `src/components/Scoreboard.tsx`

- [ ] **Step 1: Write src/components/Scoreboard.tsx**

```typescript
// src/components/Scoreboard.tsx
interface Player {
  id: string;
  name: string;
  score: number;
  isCzar: boolean;
  hasPlayed: boolean;
  isSpectator: boolean;
  isPending: boolean;
}

interface ScoreboardProps {
  players: Player[];
  currentRound: number;
  totalRounds: number;
  playedCount: number;
  totalNonCzar: number;
  layout: "panel" | "strip"; // panel = desktop side panel; strip = mobile horizontal pills
}

export function Scoreboard({
  players,
  currentRound,
  totalRounds,
  playedCount,
  totalNonCzar,
  layout,
}: ScoreboardProps) {
  const sorted = [...players]
    .filter((p) => !p.isSpectator)
    .sort((a, b) => b.score - a.score);

  const progressPct = totalNonCzar > 0 ? (playedCount / totalNonCzar) * 100 : 0;

  if (layout === "strip") {
    // Mobile: horizontal pill strip above black card
    return (
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
        {sorted.map((p) => (
          <div
            key={p.id}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold"
            style={{
              background: p.isCzar ? "rgba(249,115,22,0.15)" : "#1e293b",
              border: p.isCzar ? "1px solid rgba(249,115,22,0.4)" : "1px solid transparent",
              color: p.isCzar ? "#fed7aa" : "#e2e8f0",
            }}
          >
            <span>{p.name}</span>
            {p.isCzar && (
              <span className="px-1.5 py-0.5 rounded-full text-white font-bold"
                    style={{ background: "linear-gradient(90deg,#f97316,#ec4899)", fontSize: 9 }}>
                CZAR
              </span>
            )}
            <span style={{ color: p.hasPlayed ? "#34d399" : "#94a3b8", fontSize: 10 }}>
              {p.isCzar ? "⚖" : p.hasPlayed ? "✓" : "…"}
            </span>
            <span style={{ color: "#a78bfa", fontWeight: 800 }}>{p.score}★</span>
          </div>
        ))}
      </div>
    );
  }

  // Desktop: tall panel
  return (
    <div className="flex flex-col gap-1 h-full" style={{ background: "#0d0d1a", borderRadius: 8, padding: 10 }}>
      <p className="text-xs text-slate-500 uppercase tracking-widest mb-1">Scoreboard</p>

      {sorted.map((p) => (
        <div
          key={p.id}
          className="flex items-center justify-between rounded-lg px-2 py-1.5"
          style={{
            background: p.isCzar ? "rgba(249,115,22,0.1)" : "transparent",
            border: p.isCzar ? "1px solid rgba(249,115,22,0.2)" : "1px solid transparent",
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-bold truncate" style={{ color: p.isCzar ? "#fed7aa" : "#e2e8f0" }}>
              {p.name}
            </span>
            {p.isCzar && (
              <span className="shrink-0 px-1.5 py-0.5 rounded-full text-white font-bold"
                    style={{ background: "linear-gradient(90deg,#f97316,#ec4899)", fontSize: 8 }}>
                CZAR
              </span>
            )}
            {p.isPending && (
              <span className="text-slate-500 shrink-0" style={{ fontSize: 9 }}>pending</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {!p.isCzar && (
              <span style={{ color: p.hasPlayed ? "#34d399" : "#94a3b8", fontSize: 10 }}>
                {p.hasPlayed ? "✓" : "…"}
              </span>
            )}
            <span className="font-bold" style={{ color: "#a78bfa", fontSize: 11 }}>
              {p.score}★
            </span>
          </div>
        </div>
      ))}

      <div className="flex-1" />

      {/* Progress bar */}
      <div className="border-t border-slate-800 pt-2">
        <div className="bg-slate-800 rounded-full h-1">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${progressPct}%`,
              background: "linear-gradient(90deg, #a855f7, #ec4899)",
            }}
          />
        </div>
        <p className="text-right mt-1" style={{ fontSize: 8, color: "#475569" }}>
          {playedCount} / {totalNonCzar} played
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Scoreboard.tsx
git commit -m "feat: add Scoreboard component — panel and strip layouts"
```

---

## Task 4: HandScroll component

**Files:**
- Create: `src/components/HandScroll.tsx`

- [ ] **Step 1: Write src/components/HandScroll.tsx**

```typescript
// src/components/HandScroll.tsx
import { useRef, useState, useEffect } from "react";
import { CahCard } from "./CahCard";

interface HandCard {
  id: string;
  text: string;
}

interface HandScrollProps {
  cards: HandCard[];
  playedIds: Set<string>;
  disabled: boolean; // true during Czar's turn
  onPlay: (cardId: string) => void;
}

export function HandScroll({ cards, playedIds, disabled, onPlay }: HandScrollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showChevron, setShowChevron] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function check() {
      if (!el) return;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8;
      setShowChevron(!atEnd);
    }

    el.addEventListener("scroll", check, { passive: true });
    check();
    return () => el.removeEventListener("scroll", check);
  }, [cards]);

  return (
    <div style={{ position: "relative", overflow: "hidden" }}>
      {/* Gradient fade + chevron — only when more cards exist to the right */}
      {showChevron && (
        <>
          <div
            style={{
              position: "absolute", top: 0, right: 0,
              width: 64, height: "100%",
              background: "linear-gradient(to right, transparent, #0d1a33)",
              pointerEvents: "none", zIndex: 2,
            }}
          />
          <div
            style={{
              position: "absolute", right: 10, top: "50%",
              transform: "translateY(-50%)", zIndex: 3,
              color: "rgba(167,139,250,0.85)", fontSize: 20,
              pointerEvents: "none",
              animation: "pulse-right 1.6s ease-in-out infinite",
            }}
          >
            ›
          </div>
        </>
      )}

      <div
        ref={scrollRef}
        className="flex gap-2 overflow-x-auto pb-1"
        style={{
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        } as React.CSSProperties}
      >
        {cards.map((card) => (
          <CahCard
            key={card.id}
            variant="white"
            text={card.text}
            size="hand"
            played={playedIds.has(card.id)}
            onClick={disabled || playedIds.has(card.id) ? undefined : () => onPlay(card.id)}
            style={{ opacity: disabled ? 0.4 : 1 } as React.CSSProperties}
          />
        ))}
      </div>

      <style>{`
        @keyframes pulse-right {
          0%, 100% { opacity: 0.5; transform: translateY(-50%) translateX(0); }
          50%       { opacity: 1;   transform: translateY(-50%) translateX(4px); }
        }
        /* Hide webkit scrollbar */
        div::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/HandScroll.tsx
git commit -m "feat: add HandScroll component — hidden scrollbar, gradient fade, animated chevron"
```

---

## Task 5: SubmittedAnswers component

**Files:**
- Create: `src/components/SubmittedAnswers.tsx`

- [ ] **Step 1: Write src/components/SubmittedAnswers.tsx**

```typescript
// src/components/SubmittedAnswers.tsx
import { CahCard } from "./CahCard";

interface Submission {
  submissionId: string;
  cards: Array<{ id: number; text: string }>;
  playerName?: string; // revealed after Czar picks
}

interface SubmittedAnswersProps {
  submissions: Submission[];
  isCzar: boolean;
  winningSubmissionId: string | null; // set after Czar picks
  pendingPlayers: string[];           // player names with placeholder cards
  onPick?: (submissionId: string) => void;
}

export function SubmittedAnswers({
  submissions,
  isCzar,
  winningSubmissionId,
  pendingPlayers,
  onPick,
}: SubmittedAnswersProps) {
  return (
    <div>
      <p className="text-xs text-slate-500 uppercase tracking-widest mb-2">
        {isCzar ? "Pick the winner" : "Submitted answers"}
      </p>

      {/* CSS grid — 4 cols desktop / 3 cols mobile — wraps to new rows */}
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
      >
        {submissions.map((sub) => {
          const isWinner = sub.submissionId === winningSubmissionId;
          return (
            <div key={sub.submissionId}>
              {sub.cards.map((card, i) => (
                <CahCard
                  key={`${sub.submissionId}-${i}`}
                  variant="white"
                  text={card.text}
                  size="full"
                  selected={isCzar && !winningSubmissionId}
                  onClick={isCzar && !winningSubmissionId ? () => onPick?.(sub.submissionId) : undefined}
                  className={
                    isWinner
                      ? "ring-2 ring-yellow-400 shadow-[0_0_16px_rgba(250,204,21,0.5)]"
                      : ""
                  }
                />
              ))}
              {isWinner && sub.playerName && (
                <p className="text-center text-yellow-400 text-xs font-bold mt-1">
                  {sub.playerName} 🏆
                </p>
              )}
            </div>
          );
        })}

        {/* Placeholder cards for pending players */}
        {pendingPlayers.map((name) => (
          <CahCard
            key={`pending-${name}`}
            variant="white"
            text=""
            size="full"
            placeholder={`${name}\nthinking…`}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/SubmittedAnswers.tsx
git commit -m "feat: add SubmittedAnswers component — CSS grid, Czar pick, winner highlight"
```

---

## Task 6: Game Session screen

**Files:**
- Create: `src/routes/games/$code/session.tsx`

- [ ] **Step 1: Write src/routes/games/$code/session.tsx**

```typescript
// src/routes/games/$code/session.tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { useGameSocket } from "../../../hooks/useGameSocket";
import { CahCard } from "../../../components/CahCard";
import { Scoreboard } from "../../../components/Scoreboard";
import { HandScroll } from "../../../components/HandScroll";
import { SubmittedAnswers } from "../../../components/SubmittedAnswers";
import { useAuth } from "../../../contexts/AuthContext";

export const Route = createFileRoute("/games/$code/session")({
  validateSearch: (s: Record<string, unknown>) => ({ playerId: String(s.playerId ?? "") }),
  component: GameSessionScreen,
});

interface RoundState {
  roundNum: number;
  totalRounds: number;
  blackCard: { id: number; text: string; pick: number } | null;
  czarId: string;
  submissions: Array<{ submissionId: string; cards: Array<{ id: number; text: string }> }>;
  winningSubmissionId: string | null;
  scores: Record<string, number>;
  playerNames: Record<string, string>;
  playedIds: Set<string>;
}

function GameSessionScreen() {
  const { code } = Route.useParams();
  const { playerId } = Route.useSearch();
  const { token } = useAuth();
  const navigate = useNavigate();
  const { connected, on } = useGameSocket(code);

  const [hand, setHand] = useState<Array<{ id: string; text: string }>>([]);
  const [playedCardIds, setPlayedCardIds] = useState<Set<string>>(new Set());
  const [round, setRound] = useState<RoundState>({
    roundNum: 0,
    totalRounds: 8,
    blackCard: null,
    czarId: "",
    submissions: [],
    winningSubmissionId: null,
    scores: {},
    playerNames: {},
    playedIds: new Set(),
  });
  const [players, setPlayers] = useState<Record<string, any>>({});
  const [playedThisRound, setPlayedThisRound] = useState<Set<string>>(new Set());
  const [isSpectator, setIsSpectator] = useState(false);

  // Snapshot — initial state on connect
  on("game:snapshot", (payload: any) => {
    if (!payload) return;
    const ps = payload.players ?? {};
    setPlayers(ps);
    if (ps[playerId]?.isSpectator) setIsSpectator(true);

    if (payload.round?.blackCardId) {
      // Reconstruct round state from snapshot
      setRound((prev) => ({
        ...prev,
        czarId: payload.meta?.czarId ?? prev.czarId,
        roundNum: Number(payload.meta?.currentRound ?? prev.roundNum),
        totalRounds: Number(payload.meta?.totalRounds ?? prev.totalRounds),
        scores: Object.fromEntries(
          Object.entries(ps).map(([id, p]: [string, any]) => [id, p.score ?? 0])
        ),
        playerNames: Object.fromEntries(
          Object.entries(ps).map(([id, p]: [string, any]) => [id, p.name])
        ),
      }));
    }
  });

  on("round:started", (payload: any) => {
    setRound((prev) => ({
      ...prev,
      roundNum: payload.roundNum,
      blackCard: payload.blackCard,
      czarId: payload.czarId,
      submissions: [],
      winningSubmissionId: null,
    }));
    setPlayedThisRound(new Set());
    setPlayedCardIds(new Set());
  });

  on("card:played", (payload: any) => {
    setPlayedThisRound((prev) => new Set([...prev, payload.playerId]));
  });

  on("all:played", (payload: any) => {
    // Fetch card texts from DB via a lightweight API call
    // For now set submissions from payload (cards are IDs — fetch text)
    setRound((prev) => ({ ...prev, submissions: payload.submissions ?? [] }));
  });

  on("czar:picked", (payload: any) => {
    setRound((prev) => ({
      ...prev,
      winningSubmissionId: payload.submissionId,
      playerNames: { ...prev.playerNames, [payload.winnerId]: payload.winnerName },
    }));
  });

  on("round:ended", (payload: any) => {
    setRound((prev) => ({ ...prev, scores: payload.scores ?? prev.scores }));
  });

  on("game:ended", () => {
    navigate({ to: `/games/${code}/end`, search: { playerId } });
  });

  on("player:joined", (payload: any) => {
    setPlayers((prev) => ({
      ...prev,
      [payload.playerId]: { name: payload.name, isSpectator: payload.isSpectator, score: 0 },
    }));
  });

  on("player:left", (payload: any) => {
    setPlayers((prev) => {
      const next = { ...prev };
      delete next[payload.playerId];
      return next;
    });
  });

  async function playCard(cardId: string) {
    const res = await fetch(`/api/games/${code}/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId, cardIds: [cardId] }),
    });
    if (res.ok) {
      setPlayedCardIds((prev) => new Set([...prev, cardId]));
    }
  }

  async function pickWinner(submissionId: string) {
    await fetch(`/api/games/${code}/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ czarPlayerId: playerId, winningSubmissionId: submissionId }),
    });
  }

  const isCzar = round.czarId === playerId;

  const playerList = Object.entries(players)
    .filter(([, p]: [string, any]) => !p.isSpectator)
    .map(([id, p]: [string, any]) => ({
      id,
      name: p.name,
      score: round.scores[id] ?? p.score ?? 0,
      isCzar: id === round.czarId,
      hasPlayed: playedThisRound.has(id),
      isSpectator: p.isSpectator,
      isPending: p.isPending,
    }));

  const nonCzarCount = playerList.filter((p) => !p.isCzar).length;
  const pendingNames = playerList
    .filter((p) => !p.isCzar && !playedThisRound.has(p.id))
    .map((p) => p.name);

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "linear-gradient(135deg, #1a0533 0%, #0d1a33 100%)" }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800/50">
        <span
          className="font-black text-sm sm:text-base"
          style={{
            background: "linear-gradient(90deg, #f97316, #ec4899, #a855f7)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          CardsAgainstBhayanak
        </span>
        <span className="text-xs text-slate-500">
          Round <span className="text-purple-400">{round.roundNum}</span>/{round.totalRounds}
          {" · "}
          <span className="text-purple-400 font-mono">{code}</span>
        </span>
      </div>

      <div className="flex flex-col flex-1 gap-4 p-4 max-w-5xl mx-auto w-full">

        {/* Mobile scoreboard strip */}
        <div className="md:hidden">
          <Scoreboard
            players={playerList}
            currentRound={round.roundNum}
            totalRounds={round.totalRounds}
            playedCount={playedThisRound.size}
            totalNonCzar={nonCzarCount}
            layout="strip"
          />
        </div>

        {/* Black card + scoreboard (desktop: side by side; mobile: stacked) */}
        <div className="flex gap-4 items-stretch">
          {/* Black question card */}
          {round.blackCard ? (
            <CahCard
              variant="black"
              text={round.blackCard.text}
              pick={round.blackCard.pick}
              size="full"
            />
          ) : (
            <div
              className="flex items-center justify-center"
              style={{
                width: 170, minHeight: 238, borderRadius: 10,
                background: "#111", color: "#475569", fontSize: 12,
              }}
            >
              Waiting…
            </div>
          )}

          {/* Desktop scoreboard panel */}
          <div className="hidden md:flex flex-1">
            <div className="flex-1">
              <Scoreboard
                players={playerList}
                currentRound={round.roundNum}
                totalRounds={round.totalRounds}
                playedCount={playedThisRound.size}
                totalNonCzar={nonCzarCount}
                layout="panel"
              />
            </div>
          </div>
        </div>

        {/* Submitted answers */}
        {(round.submissions.length > 0 || pendingNames.length > 0) && (
          <SubmittedAnswers
            submissions={round.submissions.map((s) => ({
              ...s,
              playerName: round.winningSubmissionId === s.submissionId
                ? Object.entries(round.playerNames).find(([, name]) => name)?.[1]
                : undefined,
            }))}
            isCzar={isCzar}
            winningSubmissionId={round.winningSubmissionId}
            pendingPlayers={round.winningSubmissionId ? [] : pendingNames}
            onPick={pickWinner}
          />
        )}

        {/* Hand — only for active (non-spectator) players */}
        {!isSpectator && hand.length > 0 && (
          <div className="border-t border-slate-800 pt-4">
            <p className="text-xs text-slate-500 uppercase tracking-widest mb-2">
              {isCzar ? "Your hand (Czar — wait for submissions)" : "Your hand · tap to play"}
            </p>
            <HandScroll
              cards={hand}
              playedIds={playedCardIds}
              disabled={isCzar}
              onPlay={playCard}
            />
          </div>
        )}

        {!connected && (
          <p className="text-center text-yellow-500 text-xs">Reconnecting…</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/games/$code/session.tsx
git commit -m "feat: add Game Session screen — real-time WebSocket play"
```

---

## Task 7: Round Result and End Screen

**Files:**
- Create: `src/routes/games/$code/result.tsx`
- Create: `src/routes/games/$code/end.tsx`

Round result is handled inline in the Game Session screen (winner highlight + countdown) rather than a separate route. The End Screen shows final scores.

- [ ] **Step 1: Write src/routes/games/$code/end.tsx**

```typescript
// src/routes/games/$code/end.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useGameSocket } from "../../../hooks/useGameSocket";

export const Route = createFileRoute("/games/$code/end")({
  validateSearch: (s: Record<string, unknown>) => ({ playerId: String(s.playerId ?? "") }),
  component: EndScreen,
});

function EndScreen() {
  const { code } = Route.useParams();
  const { playerId } = Route.useSearch();
  const { on } = useGameSocket(code);
  const [finalScores, setFinalScores] = useState<
    Array<{ id: string; name: string; score: number }>
  >([]);
  const [isHost, setIsHost] = useState(false);

  on("game:snapshot", (payload: any) => {
    if (!payload?.players) return;
    const entries = Object.entries(payload.players as Record<string, any>)
      .filter(([, p]) => !p.isSpectator)
      .map(([id, p]) => ({ id, name: p.name, score: p.score ?? 0 }))
      .sort((a, b) => b.score - a.score);
    setFinalScores(entries);
    setIsHost(payload.players[playerId]?.isHost ?? false);
  });

  on("game:ended", (payload: any) => {
    if (!payload?.finalScores) return;
    const entries = Object.entries(
      payload.finalScores as Record<string, { name: string; score: number }>
    )
      .map(([id, v]) => ({ id, name: v.name, score: v.score }))
      .sort((a, b) => b.score - a.score);
    setFinalScores(entries);
  });

  const winner = finalScores[0];

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-4 gap-8"
      style={{ background: "linear-gradient(135deg, #1a0533 0%, #0d1a33 100%)" }}
    >
      <h1
        className="font-black text-3xl text-center"
        style={{
          background: "linear-gradient(90deg, #f97316, #ec4899, #a855f7)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}
      >
        Game Over
      </h1>

      {winner && (
        <div className="text-center">
          <p className="text-yellow-400 text-lg font-black">👑 {winner.name}</p>
          <p className="text-slate-400 text-sm">{winner.score} Awesome Points</p>
        </div>
      )}

      <div
        className="w-full max-w-sm bg-[#0d0d1a] border border-purple-900/30 rounded-2xl p-6"
      >
        <p className="text-xs text-slate-500 uppercase tracking-widest mb-3">
          Final Scoreboard
        </p>
        <ol className="flex flex-col gap-2">
          {finalScores.map((p, idx) => (
            <li
              key={p.id}
              className="flex items-center justify-between py-2 px-3 rounded-lg"
              style={{ background: idx === 0 ? "rgba(250,204,21,0.08)" : "#1e293b" }}
            >
              <span className="text-sm font-semibold text-white">
                {idx === 0 ? "👑 " : `${idx + 1}. `}{p.name}
              </span>
              <span className="font-bold text-purple-400">{p.score}★</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-3 w-full max-w-xs">
        {isHost && (
          <Link
            to="/games/create"
            className="block text-center py-3 rounded-xl font-bold text-white text-sm"
            style={{ background: "linear-gradient(90deg, #7c3aed, #ec4899)" }}
          >
            Play Again
          </Link>
        )}
        <Link
          to="/"
          className="block text-center py-3 rounded-xl font-bold text-sm text-purple-400 hover:text-white border border-purple-700/40"
        >
          Back to Home
        </Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/games/$code/end.tsx
git commit -m "feat: add End Screen / Final Scoreboard"
```

---

## Task 8: Pack picker in Create Game

**Files:**
- Modify: `src/routes/games/create.tsx`

The Create Game screen (Plan 3) defaulted to pack ID 1. Now replace it with a scrollable chip picker that loads all 73 packs from the database.

- [ ] **Step 1: Add a packs loader API route**

Create `src/routes/api/packs.ts`:

```typescript
// src/routes/api/packs.ts
import { json } from "@tanstack/start";
import { createAPIFileRoute } from "@tanstack/start/api";
import { db } from "../../db/client";
import { packs } from "../../db/schema";

export const APIRoute = createAPIFileRoute("/api/packs")({
  GET: async () => {
    const all = await db.select({ id: packs.id, name: packs.name }).from(packs).orderBy(packs.name);
    return json(all);
  },
});
```

- [ ] **Step 2: Update src/routes/games/create.tsx — add pack picker**

Open `src/routes/games/create.tsx`. Replace the `DEFAULT_PACK_IDS` constant and add a pack-picker section after the house rules:

```typescript
// In src/routes/games/create.tsx — add these state variables alongside existing ones:
const [packs, setPacks] = useState<Array<{ id: number; name: string }>>([]);
const [selectedPackIds, setSelectedPackIds] = useState<Set<number>>(new Set());

// Add this useEffect after the existing component body starts:
useEffect(() => {
  fetch("/api/packs")
    .then((r) => r.json())
    .then((data: Array<{ id: number; name: string }>) => {
      setPacks(data);
      // Default: select the first pack
      if (data.length > 0) setSelectedPackIds(new Set([data[0].id]));
    });
}, []);

function togglePack(id: number) {
  setSelectedPackIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

// In the JSX, add a pack picker section after house rules:
// Replace the existing packIds: DEFAULT_PACK_IDS in the fetch body with:
// packIds: Array.from(selectedPackIds),
```

Add the pack picker UI inside the `<form>`:

```tsx
<div>
  <label className={labelCls}>Card packs ({selectedPackIds.size} selected)</label>
  <div
    className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto pr-1"
    style={{ scrollbarWidth: "thin", scrollbarColor: "#4c1d95 transparent" }}
  >
    {packs.map((pack) => (
      <button
        type="button"
        key={pack.id}
        onClick={() => togglePack(pack.id)}
        className="px-2 py-1 rounded-full text-xs font-semibold transition-colors"
        style={{
          background: selectedPackIds.has(pack.id) ? "rgba(168,85,247,0.25)" : "#1e293b",
          border: selectedPackIds.has(pack.id) ? "1px solid #a855f7" : "1px solid #334155",
          color: selectedPackIds.has(pack.id) ? "#d8b4fe" : "#64748b",
        }}
      >
        {pack.name}
      </button>
    ))}
  </div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/api/packs.ts src/routes/games/create.tsx
git commit -m "feat: add pack picker to Create Game screen — 73 chip toggles"
```

---

## Task 9: Tailwind config — custom utilities

**Files:**
- Modify: `tailwind.config.ts`

- [ ] **Step 1: Verify scrollbar-none utility is available**

TailwindCSS v3 doesn't include `scrollbar-none` by default. Add it as a plugin or via a custom utility. Open `tailwind.config.ts`:

```typescript
// tailwind.config.ts (modify existing)
import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{tsx,ts,jsx,js}"],
  theme: {
    extend: {},
  },
  plugins: [
    function ({ addUtilities }: any) {
      addUtilities({
        ".scrollbar-none": {
          "scrollbar-width": "none",
          "-ms-overflow-style": "none",
          "&::-webkit-scrollbar": { display: "none" },
        },
      });
    },
  ],
} satisfies Config;
```

- [ ] **Step 2: Commit**

```bash
git add tailwind.config.ts
git commit -m "chore: add scrollbar-none Tailwind utility"
```

---

## Task 10: Responsive smoke test — desktop and mobile

- [ ] **Step 1: Start the full stack**

```bash
docker compose up postgres redis -d
pnpm dev
```

- [ ] **Step 2: Desktop smoke test**

Open `http://localhost:3000` in a browser at 1280px width.

Verify:
- [ ] Home screen — gradient bg, logo, three buttons, sign-in link
- [ ] `/auth` — tabbed Sign In / Register form, register a new user, JWT in localStorage
- [ ] `/games/create` — rounds/players inputs, house rules checkboxes, 73 pack chips scrollable
- [ ] `/games/join` — display name pre-filled, room code input, Player/Spectator toggle
- [ ] Create a game → Lobby — room code prominent, player list, "Start Game" button for host
- [ ] Second tab joins → both tabs show player in real time
- [ ] Start game (with 3+ players) → Game Session screen
  - [ ] Black card left (~170px wide), scoreboard panel right, same height
  - [ ] Submitted answers: 4-col grid, wraps to new rows
  - [ ] Hand: scrollable row, no scrollbar visible, gradient fade + animated `›` on right
  - [ ] Czar: hand dimmed, hover lift on submitted cards
  - [ ] Play cards → green glow on played card, Czar sees revealed cards
  - [ ] Czar picks → winner highlight (gold glow), score increments in scoreboard
- [ ] End screen — final scoreboard, "Play Again" for host

- [ ] **Step 3: Mobile smoke test**

In Chrome DevTools, toggle device toolbar to iPhone 390px width.

Verify:
- [ ] Home — full-width buttons, stacked layout
- [ ] Lobby — room code visible, player list full-width
- [ ] Game Session:
  - [ ] Scoreboard appears as horizontal pill strip **above** the black card
  - [ ] Black card is full container width
  - [ ] Submitted answers: 3-col grid (auto-fill minmax 140px)
  - [ ] Hand: cards slightly narrower (~72px), horizontally scrollable, no scrollbar
- [ ] All text readable, no overflow

- [ ] **Step 4: Commit final fixes**

Fix any layout issues found during smoke test, then:

```bash
git add -p  # stage only layout fixes
git commit -m "fix: responsive layout corrections from smoke test"
```

---

## Verification

End-to-end checklist for Plan 5:

1. `pnpm test` — all tests from Plans 1–4 still pass
2. Desktop: full game played from Home → Auth → Create → Lobby → Game Session → End Screen — zero visual regressions
3. Mobile (390px): scoreboard strip above black card, 3-col answer grid, hand scrolls cleanly
4. No visible scrollbars anywhere except pack picker (which is intentional — small vertical scrollbar inside the chip list)
5. Hand `›` chevron disappears after scrolling to the last card
6. Rando Cardrissian plays every round automatically, appears in the scoreboard

If all 6 pass, Plan 5 is complete. The full CardsAgainstBhayanak app is built and ready for deployment.

---

## Deployment note (post-Plan 5)

To build and run with Docker Compose:

```bash
# Build production image
docker compose build

# Start all services
docker compose up -d

# Seed cards (first time only)
docker compose exec app pnpm seed
```

The app will be available on port 3000. Point a reverse proxy (nginx, Caddy) at it for TLS.
