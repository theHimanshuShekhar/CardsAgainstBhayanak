import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { z } from "zod";
import { useGameSocket } from "../../../hooks/useGameSocket";
import { CahCard } from "../../../components/CahCard";
import { Scoreboard } from "../../../components/Scoreboard";
import { HandScroll } from "../../../components/HandScroll";
import { SubmittedAnswers } from "../../../components/SubmittedAnswers";

const SessionSearch = z.object({ playerId: z.coerce.string().optional().default("") });

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
      // If round is already active (round:started may have been missed during navigation),
      // re-fetch the round and hand.
      if (round.blackCardId) {
        fetch(`/api/games/${code}/round`)
          .then((r) => r.json())
          .then((data: any) => {
            if (data.round?.blackCard) setBlackCard(data.round.blackCard);
          })
          .catch(() => {});
        fetchHand();
      }
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
    <div className="min-h-[calc(100vh-3rem)] flex flex-col bg-gradient-to-br from-[#1a0533] to-[#0d1a33] font-sans">

      {/* Round info bar */}
      <div className="flex items-center justify-end px-4 py-2 border-b border-white/5">
        <span data-testid="round-display" className="text-xs text-slate-500">
          Round <span className="text-purple-400">{roundNum}</span>/{totalRounds}
          {" · "}
          <span className="text-purple-400 font-mono">{code}</span>
        </span>
      </div>

      <div className="flex-1 flex flex-col gap-4 p-4 max-w-[900px] mx-auto w-full">

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
        <div className="flex gap-4 items-stretch">
          {blackCard ? (
            <CahCard variant="black" text={blackCard.text} pick={blackCard.pick} size="full" testId="black-card" />
          ) : (
            <div className="w-[170px] min-h-[238px] rounded-[10px] bg-black flex items-center justify-center text-slate-700 text-xs">
              Waiting…
            </div>
          )}

          <div className="hidden md:flex flex-1">
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
          <div className="border-t border-slate-800 pt-4">
            <p className="text-[10px] text-slate-600 uppercase tracking-[2px] mb-2">
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
