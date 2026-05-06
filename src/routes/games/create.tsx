import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useAuth } from "../../contexts/AuthContext";

export const Route = createFileRoute("/games/create")({
  component: CreateGameScreen,
});

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
  const [packList, setPackList] = useState<Array<{ id: number; name: string }>>([]);
  const [selectedPackIds, setSelectedPackIds] = useState<Set<number>>(new Set([1]));

  useEffect(() => {
    fetch("/api/packs")
      .then((r) => r.json())
      .then((data: Array<{ id: number; name: string }>) => {
        setPackList(data);
        if (data.length > 0) setSelectedPackIds(new Set([data[0].id]));
      })
      .catch(() => {});
  }, []);

  function togglePack(id: number) {
    setSelectedPackIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/games/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          displayName,
          totalRounds,
          maxPlayers,
          packIds: Array.from(selectedPackIds),
          houseRules: { randoCardrissian, happyEnding, packingHeat },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create game");
        return;
      }
      navigate({
        to: "/games/$code/lobby",
        params: { code: data.roomCode },
        search: { playerId: data.playerId },
      });
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
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "linear-gradient(135deg, #1a0533 0%, #0d1a33 100%)" }}
    >
      <div className="w-full max-w-md bg-[#0d0d1a] border border-purple-900/30 rounded-2xl p-8 shadow-2xl">
        <h2 className="text-center font-black text-xl text-white mb-6">Create Game</h2>

        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <div>
            <label className={labelCls}>Your display name</label>
            <input
              className={inputCls}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </div>
          <div className="flex gap-4">
            <div className="flex-1">
              <label className={labelCls}>Rounds</label>
              <input
                type="number"
                className={inputCls}
                min={1}
                max={30}
                value={totalRounds}
                onChange={(e) => setTotalRounds(Number(e.target.value))}
              />
            </div>
            <div className="flex-1">
              <label className={labelCls}>Max players</label>
              <input
                type="number"
                className={inputCls}
                min={2}
                max={20}
                value={maxPlayers}
                onChange={(e) => setMaxPlayers(Number(e.target.value))}
              />
            </div>
          </div>

          <div>
            <p className={labelCls}>House rules</p>
            {[
              { key: "rando", label: "Rando Cardrissian", val: randoCardrissian, set: setRandoCardrissian },
              { key: "happy", label: "Happy Ending", val: happyEnding, set: setHappyEnding },
              { key: "heat", label: "Packing Heat", val: packingHeat, set: setPackingHeat },
            ].map(({ key, label, val, set }) => (
              <label key={key} className="flex items-center gap-2 text-sm text-slate-300 mb-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={val}
                  onChange={(e) => set(e.target.checked)}
                  className="accent-purple-500"
                />
                {label}
              </label>
            ))}
          </div>

          {packList.length > 0 && (
            <div>
              <label className={labelCls}>Card packs ({selectedPackIds.size} selected)</label>
              <div style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                maxHeight: 160,
                overflowY: "auto",
                paddingRight: 4,
                scrollbarWidth: "thin",
                scrollbarColor: "#4c1d95 transparent",
              } as React.CSSProperties}>
                {packList.map((pack) => (
                  <button
                    type="button"
                    key={pack.id}
                    onClick={() => togglePack(pack.id)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                      background: selectedPackIds.has(pack.id) ? "rgba(168,85,247,0.25)" : "#1e293b",
                      border: selectedPackIds.has(pack.id) ? "1px solid #a855f7" : "1px solid #334155",
                      color: selectedPackIds.has(pack.id) ? "#d8b4fe" : "#64748b",
                      transition: "all 0.1s",
                    }}
                  >
                    {pack.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-red-400 text-sm text-center">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="py-2 rounded-xl font-bold text-white text-sm disabled:opacity-50"
            style={{ background: "linear-gradient(90deg, #7c3aed, #ec4899)" }}
          >
            {loading ? "Creating…" : "Create Game"}
          </button>
        </form>
      </div>
    </div>
  );
}
