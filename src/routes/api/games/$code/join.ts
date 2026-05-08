import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../../../db/client";
import { gameSessions, gamePlayers } from "../../../../db/schema";
import {
  getGameStatus,
  getGamePlayers,
  addPlayerToGame,
  publishEvent,
} from "../../../../lib/game-state";
import { getRedis } from "../../../../lib/redis";
import { verifyToken } from "../../../../lib/auth";

const JoinBody = z.object({
  displayName: z.string().min(1).max(30),
  spectator: z.boolean().default(false),
});

export const Route = createFileRoute("/api/games/$code/join")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const roomCode = params.code.toUpperCase();
        const body = await request.json();
        const parsed = JoinBody.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: parsed.error.issues[0].message },
            { status: 400 }
          );
        }

        const { displayName, spectator } = parsed.data;

        const status = await getGameStatus(roomCode);
        if (!status) {
          return Response.json({ error: "Room not found" }, { status: 404 });
        }
        if (status === "ended") {
          return Response.json({ error: "Game has already ended" }, { status: 410 });
        }

        // Check max players if not a spectator
        if (!spectator) {
          const metaRaw = await getRedis().hgetall(`game:${roomCode}`);
          const config = JSON.parse(metaRaw.config ?? "{}");
          const currentPlayers = await getGamePlayers(roomCode);
          const nonSpectatorCount = Object.entries(currentPlayers).filter(
            ([id, p]) => !p.isSpectator && id !== "rando_cardrissian"
          ).length;
          if (nonSpectatorCount >= config.maxPlayers) {
            return Response.json({ error: "Game is full" }, { status: 400 });
          }
        }

        const isPending = status === "active" && !spectator;

        const authHeader = request.headers.get("Authorization") ?? "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
        const jwtPayload = token ? await verifyToken(token) : null;

        const [session] = await db
          .select()
          .from(gameSessions)
          .where(eq(gameSessions.roomCode, roomCode))
          .limit(1);

        const [dbPlayer] = await db
          .insert(gamePlayers)
          .values({
            sessionId: session.id,
            userId: jwtPayload ? Number(jwtPayload.sub) : undefined,
            displayName,
            isSpectator: spectator,
            isHost: false,
          })
          .returning();

        const playerId = String(dbPlayer.id);

        await addPlayerToGame(roomCode, playerId, {
          name: displayName,
          userId: jwtPayload?.sub,
          score: 0,
          isHost: false,
          isSpectator: spectator,
          isPending,
        });

        await publishEvent(roomCode, "player:joined", {
          playerId,
          name: displayName,
          isSpectator: spectator,
          isPending,
        });

        return Response.json({ playerId, roomCode, isPending, status });
      },
    },
  },
});
