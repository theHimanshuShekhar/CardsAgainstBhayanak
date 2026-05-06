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
      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4, scrollbarWidth: "none" }}>
        {sorted.map((p) => (
          <div
            key={p.id}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              borderRadius: 999,
              background: p.isCzar ? "rgba(249,115,22,0.15)" : "#1e293b",
              border: p.isCzar ? "1px solid rgba(249,115,22,0.4)" : "1px solid transparent",
              color: p.isCzar ? "#fed7aa" : "#e2e8f0",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            <span>{p.name}</span>
            {p.isCzar && (
              <span style={{
                padding: "2px 6px",
                borderRadius: 999,
                background: "linear-gradient(90deg,#f97316,#ec4899)",
                color: "#fff",
                fontWeight: 700,
                fontSize: 9,
              }}>
                CZAR
              </span>
            )}
            <span style={{ color: p.isCzar ? "#94a3b8" : p.hasPlayed ? "#34d399" : "#94a3b8", fontSize: 10 }}>
              {p.isCzar ? "⚖" : p.hasPlayed ? "✓" : "…"}
            </span>
            <span style={{ color: "#a78bfa", fontWeight: 800 }}>{p.score}★</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      gap: 4,
      height: "100%",
      background: "#0d0d1a",
      borderRadius: 8,
      padding: 10,
    }}>
      <p style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 2, marginBottom: 4 }}>
        Scoreboard · Round {currentRound}/{totalRounds}
      </p>

      {sorted.map((p) => (
        <div
          key={p.id}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderRadius: 8,
            padding: "6px 8px",
            background: p.isCzar ? "rgba(249,115,22,0.1)" : "transparent",
            border: p.isCzar ? "1px solid rgba(249,115,22,0.2)" : "1px solid transparent",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: p.isCzar ? "#fed7aa" : "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {p.name}
            </span>
            {p.isCzar && (
              <span style={{
                flexShrink: 0,
                padding: "1px 5px",
                borderRadius: 999,
                background: "linear-gradient(90deg,#f97316,#ec4899)",
                color: "#fff",
                fontWeight: 700,
                fontSize: 8,
              }}>
                CZAR
              </span>
            )}
            {p.isPending && (
              <span style={{ color: "#475569", fontSize: 9, flexShrink: 0 }}>pending</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {!p.isCzar && (
              <span style={{ color: p.hasPlayed ? "#34d399" : "#94a3b8", fontSize: 10 }}>
                {p.hasPlayed ? "✓" : "…"}
              </span>
            )}
            <span style={{ color: "#a78bfa", fontWeight: 800, fontSize: 11 }}>{p.score}★</span>
          </div>
        </div>
      ))}

      <div style={{ flex: 1 }} />

      <div style={{ borderTop: "1px solid #1e293b", paddingTop: 8 }}>
        <div style={{ background: "#1e293b", borderRadius: 999, height: 4 }}>
          <div style={{
            height: "100%",
            borderRadius: 999,
            width: `${progressPct}%`,
            background: "linear-gradient(90deg, #a855f7, #ec4899)",
            transition: "width 0.3s",
          }} />
        </div>
        <p style={{ textAlign: "right", marginTop: 4, fontSize: 8, color: "#475569" }}>
          {playedCount} / {totalNonCzar} played
        </p>
      </div>
    </div>
  );
}
