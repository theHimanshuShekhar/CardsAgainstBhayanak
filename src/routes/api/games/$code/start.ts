import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { db } from "../../../../db/client";
import { gameSessions } from "../../../../db/schema";
import {
  getGameStatus,
  getGamePlayers,
  publishEvent,
} from "../../../../lib/game-state";
import { getRedis } from "../../../../lib/redis";

export const Route = createFileRoute("/api/games/$code/start")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const roomCode = params.code.toUpperCase();

        const status = await getGameStatus(roomCode);
        if (!status) {
          return Response.json({ error: "Room not found" }, { status: 404 });
        }
        if (status !== "waiting") {
          return Response.json({ error: "Game already started" }, { status: 409 });
        }

        const body = await request.json().catch(() => ({}));
        const { playerId } = body as { playerId?: string };

        const players = await getGamePlayers(roomCode);
        const requestor = playerId ? players[playerId] : null;
        if (!requestor?.isHost) {
          return Response.json(
            { error: "Only the host can start the game" },
            { status: 403 }
          );
        }

        const activePlayers = Object.values(players).filter(
          (p) => !p.isSpectator && !p.isPending
        );
        const configRaw = await getRedis().hget(`game:${roomCode}`, "config");
        const config = configRaw ? JSON.parse(configRaw) : {};
        const minPlayers = config.houseRules?.randoCardrissian ? 2 : 3;

        if (activePlayers.length < minPlayers) {
          return Response.json(
            { error: `Need at least ${minPlayers} players to start` },
            { status: 422 }
          );
        }

        const redis = getRedis();
        await redis.hset(`game:${roomCode}`, "status", "active");

        await db
          .update(gameSessions)
          .set({ status: "active", startedAt: new Date() })
          .where(eq(gameSessions.roomCode, roomCode));

        await publishEvent(roomCode, "game:started", { config });

        return Response.json({ ok: true });
      },
    },
  },
});
