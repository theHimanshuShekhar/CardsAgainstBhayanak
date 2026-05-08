import { createFileRoute } from "@tanstack/react-router";
import { eq, and } from "drizzle-orm";
import { db } from "../../../../db/client";
import { users, gamePlayers, gameSessions } from "../../../../db/schema";

export const Route = createFileRoute("/api/users/$username/stats")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { username } = params;

        const [user] = await db
          .select({
            id: users.id,
            username: users.username,
            createdAt: users.createdAt,
          })
          .from(users)
          .where(eq(users.username, username))
          .limit(1);

        if (!user) {
          return Response.json({ error: "User not found" }, { status: 404 });
        }

        const sessions = await db
          .select({
            sessionId: gamePlayers.sessionId,
            finalScore: gamePlayers.finalScore,
            isWinner: gamePlayers.isWinner,
            status: gameSessions.status,
            endedAt: gameSessions.endedAt,
          })
          .from(gamePlayers)
          .innerJoin(
            gameSessions,
            eq(gamePlayers.sessionId, gameSessions.id)
          )
          .where(
            and(
              eq(gamePlayers.userId, user.id),
              eq(gamePlayers.isSpectator, false)
            )
          )
          .orderBy(gameSessions.endedAt)
          .limit(50);

        const completed = sessions.filter((s) => s.status === "ended");
        const gamesPlayed = completed.length;
        const gamesWon = completed.filter((s) => s.isWinner).length;
        const gamesLost = completed.filter((s) => !s.isWinner).length;
        const totalPoints = completed.reduce(
          (acc, s) => acc + (s.finalScore ?? 0),
          0
        );
        const bestScore = completed.reduce(
          (acc, s) => Math.max(acc, s.finalScore ?? 0),
          0
        );

        return Response.json({
          username: user.username,
          createdAt: user.createdAt,
          gamesPlayed,
          gamesWon,
          gamesLost,
          totalPoints,
          bestScore,
          recentSessions: completed.slice(-50).map((s) => ({
            sessionId: s.sessionId,
            finalScore: s.finalScore,
            isWinner: s.isWinner,
            endedAt: s.endedAt,
          })),
        });
      },
    },
  },
});
