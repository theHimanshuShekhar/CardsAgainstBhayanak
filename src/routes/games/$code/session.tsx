import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import { useGameSocket } from "../../../hooks/useGameSocket";
import { CahCard } from "../../../components/CahCard";
import { Scoreboard } from "../../../components/Scoreboard";
import { HandScroll } from "../../../components/HandScroll";
import { SubmittedAnswers } from "../../../components/SubmittedAnswers";

const SessionSearch = z.object({ playerId: z.string().optional().default("") });

export const Route = createFileRoute("/games/$code/session")({
  validateSearch: SessionSearch.parse,
  component: GameSessionScreen,
});

interface BlackCard {
  id: number;
  text: string;
  pick: number;
}

interface Submission {
  submissionId: string;
  cards: Array<{ id: number; text: string }>;
  playerName?: string;
}

interface PlayerEntry {
  id: string;
  name: string;
  score: number;
  isCzar: boolean;
  hasPlayed: boolean;
  isSpectator: boolean;
  isPending: boolean;
}

function GameSessionScreen() {
  const { code } = Route.useParams();
  const { playerId } = Route.useSearch();
  const { connected, on } = useGameSocket(code);

  const [hand, setHand] = useState<Array<{ id: string; text: string }>>([]);
  const [playedCardIds, setPlayedCardIds] = useState<Set<string>>(new Set());
  const [blackCard, setBlackCard] = useState<BlackCard | null>(null);
  const [czarId, setCzarId] = useState("");
  const [roundNum, setRoundNum] = useState(0);
  const [totalRounds, setTotalRounds] = useState(8);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [winningSubmissionId, setWinningSubmissionId] = useState<string | null>(null);
  const [playedThisRound, setPlayedThisRound] = useState<Set<string>>(new Set());
  const [players, setPlayers] = useState<Record<string, any>>({});
  const [scores, setScores] = useState<Record<string, number>>({});
  const [isSpectator, setIsSpectator] = useState(false);
  const winnerNamesRef = useRef<Record<string, string>>({});

  async function fetchHand() {
    try {
      const res = await fetch(`/api/games/${code}/hand?playerId=${encodeURIComponent(playerId)}`);
      if (res.ok) {
        const data = await res.json();
        setHand(data.cards ?? []);
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    fetchHand();
    // Restore active round state on mount/refresh
    fetch(`/api/games/${code}/round`)
      .then((r) => r.json())
      .then((data: any) => {
        if (!data.round) return;
        if (data.round.czarId) setCzarId(data.round.czarId);
        if (data.round.blackCard) setBlackCard(data.round.blackCard);
      })
      .catch(() => {});
  }, [code, playerId]);

  useEffect(() => {
    on("game:snapshot", (payload: any) => {
      if (!payload) return;
      const ps = payload.players ?? {};
      setPlayers(ps);
      if (ps[playerId]?.isSpectator) setIsSpectator(true);
      const meta = payload.meta ?? {};
      setRoundNum(Number(meta.currentRound ?? 0));
      setTotalRounds(Number(meta.totalRounds ?? 8));
      setScores(
        Object.fromEntries(
          Object.entries(ps).map(([id, p]: [string, any]) => [id, p.score ?? 0])
        )
      );
      winnerNamesRef.current = Object.fromEntries(
        Object.entries(ps).map(([id, p]: [string, any]) => [id, p.name])
      );
      const round = payload.round ?? {};
      if (round.czarId) setCzarId(round.czarId);
    });

    on("round:started", (payload: any) => {
      setBlackCard(payload.blackCard);
      setCzarId(payload.czarId);
      setRoundNum(payload.roundNum);
      setSubmissions([]);
      setWinningSubmissionId(null);
      setPlayedThisRound(new Set());
      setPlayedCardIds(new Set());
      fetchHand();
    });

    on("card:played", (payload: any) => {
      setPlayedThisRound((prev) => new Set([...prev, payload.playerId]));
    });

    on("all:played", (payload: any) => {
      setSubmissions(payload.submissions ?? []);
    });

    on("czar:picked", (payload: any) => {
      winnerNamesRef.current[payload.winnerId] = payload.winnerName;
      setWinningSubmissionId(payload.submissionId);
      setSubmissions((prev) =>
        prev.map((s) =>
          s.submissionId === payload.submissionId
            ? { ...s, playerName: payload.winnerName }
            : s
        )
      );
    });

    on("round:ended", (payload: any) => {
      setScores(payload.scores ?? {});
    });

    on("game:ended", () => {
      window.location.href = `/games/${code}/end?playerId=${encodeURIComponent(playerId)}`;
    });

    on("player:joined", (payload: any) => {
      setPlayers((prev) => ({
        ...prev,
        [payload.playerId]: {
          name: payload.name,
          isSpectator: payload.isSpectator,
          score: 0,
          isHost: false,
          isPending: false,
        },
      }));
    });

    on("player:left", (payload: any) => {
      setPlayers((prev) => {
        const next = { ...prev };
        delete next[payload.playerId];
        return next;
      });
    });
  }, [on, code, playerId]);

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

  const isCzar = czarId === playerId;

  const playerList: PlayerEntry[] = Object.entries(players)
    .filter(([, p]: [string, any]) => !p.isSpectator)
    .map(([id, p]: [string, any]) => ({
      id,
      name: p.name,
      score: scores[id] ?? p.score ?? 0,
      isCzar: id === czarId,
      hasPlayed: playedThisRound.has(id),
      isSpectator: p.isSpectator,
      isPending: !!p.isPending,
    }));

  const nonCzarCount = playerList.filter((p) => !p.isCzar).length;
  const pendingNames = playerList
    .filter((p) => !p.isCzar && !playedThisRound.has(p.id))
    .map((p) => p.name);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "linear-gradient(135deg, #1a0533 0%, #0d1a33 100%)",
        fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      }}
    >
      {/* Top bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        borderBottom: "1px solid rgba(100,116,139,0.2)",
      }}>
        <span style={{
          fontWeight: 900,
          fontSize: 15,
          background: "linear-gradient(90deg, #f97316, #ec4899, #a855f7)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}>
          CardsAgainstBhayanak
        </span>
        <span style={{ fontSize: 12, color: "#475569" }}>
          Round <span style={{ color: "#a855f7" }}>{roundNum}</span>/{totalRounds}
          {" · "}
          <span style={{ color: "#a855f7", fontFamily: "monospace" }}>{code}</span>
        </span>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, padding: 16, maxWidth: 900, margin: "0 auto", width: "100%" }}>

        {/* Mobile scoreboard strip */}
        <div className="md:hidden">
          <Scoreboard
            players={playerList}
            currentRound={roundNum}
            totalRounds={totalRounds}
            playedCount={playedThisRound.size}
            totalNonCzar={nonCzarCount}
            layout="strip"
          />
        </div>

        {/* Black card + scoreboard panel */}
        <div style={{ display: "flex", gap: 16, alignItems: "stretch" }}>
          {blackCard ? (
            <CahCard variant="black" text={blackCard.text} pick={blackCard.pick} size="full" />
          ) : (
            <div style={{
              width: 170, minHeight: 238, borderRadius: 10,
              background: "#111", display: "flex",
              alignItems: "center", justifyContent: "center",
              color: "#475569", fontSize: 12,
            }}>
              Waiting…
            </div>
          )}

          <div className="hidden md:flex" style={{ flex: 1 }}>
            <Scoreboard
              players={playerList}
              currentRound={roundNum}
              totalRounds={totalRounds}
              playedCount={playedThisRound.size}
              totalNonCzar={nonCzarCount}
              layout="panel"
            />
          </div>
        </div>

        {/* Submitted answers */}
        {(submissions.length > 0 || pendingNames.length > 0) && (
          <SubmittedAnswers
            submissions={submissions}
            isCzar={isCzar}
            winningSubmissionId={winningSubmissionId}
            pendingPlayers={winningSubmissionId ? [] : pendingNames}
            onPick={pickWinner}
          />
        )}

        {/* Hand */}
        {!isSpectator && hand.length > 0 && (
          <div style={{ borderTop: "1px solid #1e293b", paddingTop: 16 }}>
            <p style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 2, marginBottom: 8 }}>
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
          <p style={{ textAlign: "center", color: "#eab308", fontSize: 12 }}>Reconnecting…</p>
        )}
      </div>
    </div>
  );
}
