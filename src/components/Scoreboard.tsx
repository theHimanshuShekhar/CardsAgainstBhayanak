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
  layout: "panel" | "strip";
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
    return (
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
        {sorted.map((p) => (
          <div
            key={p.id}
            className={[
              "shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold",
              p.isCzar
                ? "bg-orange-500/15 border border-orange-500/40 text-orange-200"
                : "bg-slate-800 border border-transparent text-slate-200",
            ].join(" ")}
          >
            <span>{p.name}</span>
            {p.isCzar && (
              <span className="px-1.5 py-0.5 rounded-full bg-gradient-to-r from-orange-500 to-pink-500 text-white font-bold text-[9px]">
                CZAR
              </span>
            )}
            <span className={[
              "text-[10px]",
              p.isCzar ? "text-slate-400" : p.hasPlayed ? "text-emerald-400" : "text-slate-400",
            ].join(" ")}>
              {p.isCzar ? "⚖" : p.hasPlayed ? "✓" : "…"}
            </span>
            <span className="text-violet-400 font-extrabold">{p.score}★</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 h-full bg-[#0d0d1a] rounded-lg p-2.5">
      <p className="text-[10px] text-slate-600 uppercase tracking-[2px] mb-1">
        Scoreboard · Round {currentRound}/{totalRounds}
      </p>

      {sorted.map((p) => (
        <div
          key={p.id}
          className={[
            "flex items-center justify-between rounded-lg px-2 py-1.5",
            p.isCzar
              ? "bg-orange-500/10 border border-orange-500/20"
              : "border border-transparent",
          ].join(" ")}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={[
              "text-xs font-bold truncate",
              p.isCzar ? "text-orange-200" : "text-slate-200",
            ].join(" ")}>
              {p.name}
            </span>
            {p.isCzar && (
              <span className="shrink-0 px-[5px] py-px rounded-full bg-gradient-to-r from-orange-500 to-pink-500 text-white font-bold text-[8px]">
                CZAR
              </span>
            )}
            {p.isPending && (
              <span className="text-slate-600 text-[9px] shrink-0">pending</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {!p.isCzar && (
              <span className={`text-[10px] ${p.hasPlayed ? "text-emerald-400" : "text-slate-400"}`}>
                {p.hasPlayed ? "✓" : "…"}
              </span>
            )}
            <span className="text-violet-400 font-extrabold text-[11px]">{p.score}★</span>
          </div>
        </div>
      ))}

      <div className="flex-1" />

      <div className="border-t border-slate-800 pt-2">
        <div className="bg-slate-800 rounded-full h-1">
          <div
            className="h-full rounded-full bg-gradient-to-r from-purple-500 to-pink-500 transition-[width] duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <p className="text-right mt-1 text-[8px] text-slate-600">
          {playedCount} / {totalNonCzar} played
        </p>
      </div>
    </div>
  );
}
