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
      if (data.status === "active") {
        window.location.href = `/games/${code}/session?playerId=${encodeURIComponent(data.playerId)}`;
      } else {
        navigate({
          to: "/games/$code/lobby",
          params: { code },
          search: { playerId: data.playerId },
        });
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
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "linear-gradient(135deg, #1a0533 0%, #0d1a33 100%)" }}
    >
      <div className="w-full max-w-sm bg-[#0d0d1a] border border-purple-900/30 rounded-2xl p-8 shadow-2xl">
        <h2 className="text-center font-black text-xl text-white mb-6">Join Game</h2>

        <form onSubmit={handleJoin} className="flex flex-col gap-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1 uppercase tracking-widest">
              Display name
            </label>
            <input
              className={inputCls}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
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

          <button
            type="submit"
            disabled={loading}
            className="py-2 rounded-xl font-bold text-white text-sm disabled:opacity-50"
            style={{ background: "linear-gradient(90deg, #7c3aed, #ec4899)" }}
          >
            {loading ? "Joining…" : "Join Game"}
          </button>
        </form>
      </div>
    </div>
  );
}
