import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { z } from "zod";
import { useGameSocket } from "../../../hooks/useGameSocket";

const LobbySearch = z.object({ playerId: z.string().optional().default("") });

export const Route = createFileRoute("/games/$code/lobby")({
  validateSearch: LobbySearch.parse,
  component: LobbyScreen,
});

interface LobbyPlayer {
  id: string;
  name: string;
  isHost: boolean;
  isSpectator: boolean;
}

function LobbyScreen() {
  const { code } = Route.useParams();
  const { playerId } = Route.useSearch();
  const navigate = useNavigate();
  const { connected, on } = useGameSocket(code);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    on("game:snapshot", (payload: unknown) => {
      const p = (payload as any)?.players;
      if (!p) return;
      setPlayers(
        Object.entries(p).map(([id, player]: [string, any]) => ({
          id,
          name: player.name,
          isHost: player.isHost,
          isSpectator: player.isSpectator,
        }))
      );
    });

    on("player:joined", (payload: unknown) => {
      const p = payload as any;
      setPlayers((prev) => {
        if (prev.some((pl) => pl.id === p.playerId)) return prev;
        return [
          ...prev,
          { id: p.playerId, name: p.name, isHost: false, isSpectator: p.isSpectator },
        ];
      });
    });

    on("player:left", (payload: unknown) => {
      const p = payload as any;
      setPlayers((prev) => prev.filter((pl) => pl.id !== p.playerId));
    });

    on("game:started", () => {
      window.location.href = `/games/${code}/session?playerId=${encodeURIComponent(playerId)}`;
    });
  }, [on, navigate, code, playerId]);

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
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "linear-gradient(135deg, #1a0533 0%, #0d1a33 100%)" }}
    >
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <p className="text-slate-400 text-xs uppercase tracking-widest mb-1">Room code</p>
          <p
            className="font-black text-5xl tracking-widest"
            style={{
              background: "linear-gradient(90deg, #f97316, #ec4899, #a855f7)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            {code}
          </p>
        </div>

        <div className="bg-[#0d0d1a] border border-purple-900/30 rounded-2xl p-6 mb-4">
          <p className="text-xs text-slate-500 uppercase tracking-widest mb-3">
            Players ({activePlayers.length})
          </p>
          <ul className="flex flex-col gap-2">
            {activePlayers.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between py-2 px-3 rounded-lg bg-[#1e293b]"
              >
                <span className="text-sm font-semibold text-white">{p.name}</span>
                <span className="flex gap-1.5 items-center">
                  {p.isHost && (
                    <span
                      className="text-xs font-bold px-2 py-0.5 rounded-full text-white"
                      style={{ background: "linear-gradient(90deg,#f97316,#ec4899)" }}
                    >
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

        {error && <p className="text-red-400 text-sm text-center mb-2">{error}</p>}

        {me?.isHost ? (
          <button
            onClick={handleStart}
            disabled={loading || activePlayers.length < 3}
            className="w-full py-3 rounded-xl font-bold text-white text-sm disabled:opacity-40"
            style={{ background: "linear-gradient(90deg, #7c3aed, #ec4899)" }}
          >
            {loading ? "Starting…" : `Start Game (${activePlayers.length}/3 min)`}
          </button>
        ) : (
          <p className="text-center text-slate-400 text-sm">
            Waiting for host to start…
          </p>
        )}

        {!connected && (
          <p className="text-center text-yellow-500 text-xs mt-3">Reconnecting…</p>
        )}
      </div>
    </div>
  );
}
