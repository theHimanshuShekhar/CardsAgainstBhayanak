import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { z } from "zod";

const ProfileSearch = z.object({});

export const Route = createFileRoute("/users/$username")({
  validateSearch: ProfileSearch.parse,
  component: ProfilePage,
});

interface Stats {
  username: string;
  createdAt: string;
  gamesPlayed: number;
  gamesWon: number;
  gamesLost: number;
  totalPoints: number;
  bestScore: number;
  recentSessions: Array<{
    sessionId: number;
    finalScore: number | null;
    isWinner: boolean;
    endedAt: string | null;
  }>;
}

function ProfilePage() {
  const { username } = Route.useParams();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch(`/api/users/${encodeURIComponent(username)}/stats`);
        if (!res.ok) {
          if (res.status === 404) {
            setError("User not found");
          } else {
            setError("Failed to load profile");
          }
          return;
        }
        const data = await res.json();
        setStats(data);
      } catch (err) {
        setError("Error loading profile");
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [username]);

  if (loading) {
    return (
      <div className="min-h-[calc(100vh-3rem)] flex items-center justify-center px-4">
        <p className="text-slate-500">Loading...</p>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="min-h-[calc(100vh-3rem)] flex flex-col items-center justify-center px-4 gap-4">
        <p className="text-slate-500">{error}</p>
        <Link
          to="/"
          className="block py-2 px-4 rounded-lg text-sm text-violet-400 border border-violet-900/40 no-underline hover:bg-violet-900/20"
        >
          Back to Home
        </Link>
      </div>
    );
  }

  const memberSinceDate = new Date(stats.createdAt);
  const memberSinceFormatted = memberSinceDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
  });

  const winRate = stats.gamesPlayed > 0
    ? Math.round((stats.gamesWon / stats.gamesPlayed) * 100)
    : 0;

  return (
    <main className="min-h-[calc(100vh-3rem)] px-4 py-12 bg-gradient-to-br from-[#1a0533] to-[#0d1a33]">
      <div className="w-full max-w-2xl mx-auto">
        {/* Username Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-black bg-gradient-to-r from-orange-500 via-pink-500 to-purple-500 bg-clip-text text-transparent mb-2">
            {stats.username}
          </h1>
          <p className="text-slate-500 text-sm">
            Member since {memberSinceFormatted}
          </p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
          <StatCard label="Games Played" value={stats.gamesPlayed.toString()} />
          <StatCard label="Games Won" value={stats.gamesWon.toString()} />
          <StatCard label="Games Lost" value={stats.gamesLost.toString()} />
          <StatCard label="Win Rate" value={`${winRate}%`} />
          <StatCard label="Total Points" value={stats.totalPoints.toString()} />
          <StatCard label="Best Score" value={stats.bestScore.toString()} />
        </div>

        {/* Recent Games */}
        {stats.recentSessions.length > 0 && (
          <div className="bg-[#0d0d1a] border border-purple-900/30 rounded-2xl p-6">
            <p className="text-[10px] text-slate-600 uppercase tracking-[2px] mb-4">
              Recent Games (Last 10)
            </p>
            <div className="flex flex-col gap-2">
              {stats.recentSessions.slice(-10).reverse().map((session, idx) => {
                const sessionDate = session.endedAt
                  ? new Date(session.endedAt).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })
                  : "Unknown";

                return (
                  <div
                    key={idx}
                    className="flex items-center justify-between px-3 py-2 rounded-[10px] bg-slate-800/50"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-slate-400">
                        {sessionDate}
                      </span>
                      <span className="text-sm font-semibold text-slate-300">
                        {session.finalScore ?? 0} points
                      </span>
                    </div>
                    <span
                      className={`px-2 py-1 text-xs font-bold rounded ${
                        session.isWinner
                          ? "bg-yellow-400/20 text-yellow-400"
                          : "bg-slate-700/50 text-slate-400"
                      }`}
                    >
                      {session.isWinner ? "W" : "L"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Back to Home */}
        <div className="flex justify-center mt-8">
          <Link
            to="/"
            className="inline-block py-2 px-6 rounded-lg text-sm text-violet-400 border border-violet-900/40 no-underline hover:bg-violet-900/20"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </main>
  );
}

interface StatCardProps {
  label: string;
  value: string;
}

function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="bg-[#0d0d1a] border border-purple-900/30 rounded-2xl p-4 text-center">
      <p className="text-[10px] text-slate-600 uppercase tracking-[2px] mb-2">
        {label}
      </p>
      <p className="text-2xl font-black text-violet-400">{value}</p>
    </div>
  );
}
