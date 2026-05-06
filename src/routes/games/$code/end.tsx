import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { z } from "zod";
import { useGameSocket } from "../../../hooks/useGameSocket";

const EndSearch = z.object({ playerId: z.string().optional().default("") });

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
    <div style={{
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
      gap: 32,
      background: "linear-gradient(135deg, #1a0533 0%, #0d1a33 100%)",
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    }}>
      <h1 style={{
        fontWeight: 900,
        fontSize: 32,
        textAlign: "center",
        background: "linear-gradient(90deg, #f97316, #ec4899, #a855f7)",
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent",
      }}>
        Game Over
      </h1>

      {winner && (
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "#facc15", fontSize: 20, fontWeight: 900 }}>👑 {winner.name}</p>
          <p style={{ color: "#64748b", fontSize: 14 }}>{winner.score} Awesome Points</p>
        </div>
      )}

      <div style={{
        width: "100%",
        maxWidth: 360,
        background: "#0d0d1a",
        border: "1px solid rgba(126,34,206,0.3)",
        borderRadius: 16,
        padding: 24,
      }}>
        <p style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 2, marginBottom: 12 }}>
          Final Scoreboard
        </p>
        <ol style={{ display: "flex", flexDirection: "column", gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
          {finalScores.map((p, idx) => (
            <li
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px",
                borderRadius: 10,
                background: idx === 0 ? "rgba(250,204,21,0.08)" : "#1e293b",
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>
                {idx === 0 ? "👑 " : `${idx + 1}. `}{p.name}
              </span>
              <span style={{ fontWeight: 800, color: "#a78bfa" }}>{p.score}★</span>
            </li>
          ))}
        </ol>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 280 }}>
        {isHost && (
          <Link
            to="/games/create"
            style={{
              display: "block",
              textAlign: "center",
              padding: "12px 0",
              borderRadius: 12,
              fontWeight: 700,
              color: "#fff",
              fontSize: 14,
              background: "linear-gradient(90deg, #7c3aed, #ec4899)",
              textDecoration: "none",
            }}
          >
            Play Again
          </Link>
        )}
        <Link
          to="/"
          style={{
            display: "block",
            textAlign: "center",
            padding: "12px 0",
            borderRadius: 12,
            fontWeight: 700,
            fontSize: 14,
            color: "#a78bfa",
            border: "1px solid rgba(126,34,206,0.4)",
            textDecoration: "none",
          }}
        >
          Back to Home
        </Link>
      </div>
    </div>
  );
}
