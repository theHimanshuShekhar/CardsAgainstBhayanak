import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { z } from "zod";
import { useGameSocket } from "../../../hooks/useGameSocket";

const EndSearch = z.object({ playerId: z.coerce.string().optional().default("") });

export const Route = createFileRoute("/games/$code/end")({
  validateSearch: EndSearch.parse,
  component: EndScreen,
});

interface FinalPlayer {
  id: string;
  name: string;
  score: number;
}

function EndScreen() {
  const { code } = Route.useParams();
  const { playerId } = Route.useSearch();
  const { on } = useGameSocket(code);
  const [finalScores, setFinalScores] = useState<FinalPlayer[]>([]);
  const [isHost, setIsHost] = useState(false);

  useEffect(() => {
    on("game:snapshot", (payload: any) => {
      if (!payload?.players) return;
      const entries: FinalPlayer[] = Object.entries(payload.players as Record<string, any>)
        .filter(([, p]) => !p.isSpectator)
        .map(([id, p]) => ({ id, name: p.name, score: p.score ?? 0 }))
        .sort((a, b) => b.score - a.score);
      setFinalScores(entries);
      setIsHost(payload.players[playerId]?.isHost ?? false);
    });

    on("game:ended", (payload: any) => {
      if (!payload?.finalScores) return;
      const entries: FinalPlayer[] = Object.entries(
        payload.finalScores as Record<string, { name: string; score: number }>
      )
        .map(([id, v]) => ({ id, name: v.name, score: v.score }))
        .sort((a, b) => b.score - a.score);
      setFinalScores(entries);
    });
  }, [on, playerId]);

  const winner = finalScores[0];

  return (
    <div className="min-h-[calc(100vh-3rem)] flex flex-col items-center justify-center px-4 gap-8 bg-gradient-to-br from-[#1a0533] to-[#0d1a33]">

      <h1 className="font-black text-4xl text-center bg-gradient-to-r from-orange-500 via-pink-500 to-purple-500 bg-clip-text text-transparent">
        Game Over
      </h1>

      {winner && (
        <div className="text-center">
          <p className="text-yellow-400 text-xl font-black">👑 {winner.name}</p>
          <p className="text-slate-500 text-sm mt-1">{winner.score} Awesome Points</p>
        </div>
      )}

      <div className="w-full max-w-sm bg-[#0d0d1a] border border-purple-900/30 rounded-2xl p-6">
        <p className="text-[10px] text-slate-600 uppercase tracking-[2px] mb-3">Final Scoreboard</p>
        <ol className="flex flex-col gap-2 list-none p-0 m-0">
          {finalScores.map((p, idx) => (
            <li
              key={p.id}
              className={[
                "flex items-center justify-between px-3 py-2 rounded-[10px]",
                idx === 0 ? "bg-yellow-400/8" : "bg-slate-800",
              ].join(" ")}
            >
              <span className="text-sm font-semibold text-white">
                {idx === 0 ? "👑 " : `${idx + 1}. `}{p.name}
              </span>
              <span className="font-extrabold text-violet-400">{p.score}★</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-3 w-full max-w-[280px]">
        {isHost && (
          <Link
            to="/games/create"
            className="block text-center py-3 rounded-xl font-bold text-white text-sm bg-gradient-to-r from-violet-700 to-pink-500 no-underline"
          >
            Play Again
          </Link>
        )}
        <Link
          to="/"
          className="block text-center py-3 rounded-xl font-bold text-sm text-violet-400 border border-violet-900/40 no-underline hover:bg-violet-900/20"
        >
          Back to Home
        </Link>
      </div>

    </div>
  );
}
