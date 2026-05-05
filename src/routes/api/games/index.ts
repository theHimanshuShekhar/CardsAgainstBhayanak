import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { db } from "../../../db/client";
import { gameSessions, gamePlayers } from "../../../db/schema";
import { generateRoomCode } from "../../../lib/room-code";
import { createGameState } from "../../../lib/game-state";
import { verifyToken } from "../../../lib/auth";
import { eq, notInArray, and } from "drizzle-orm";

const CreateGameBody = z.object({
  displayName: z.string().min(1).max(30),
  totalRounds: z.number().int().min(1).max(30).default(8),
  maxPlayers: z.number().int().min(2).max(20).default(10),
  packIds: z.array(z.number().int()).min(1),
  houseRules: z.object({
    randoCardrissian: z.boolean().default(false),
    happyEnding: z.boolean().default(false),
    packingHeat: z.boolean().default(false),
  }),
});

export const Route = createFileRoute("/api/games/")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json();
        const parsed = CreateGameBody.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: parsed.error.issues[0].message },
            { status: 400 }
          );
        }

        const authHeader = request.headers.get("Authorization") ?? "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
        const jwtPayload = token ? await verifyToken(token) : null;

        const { displayName, totalRounds, maxPlayers, packIds, houseRules } = parsed.data;

        // Generate unique room code — retry up to 5 times on collision
        let roomCode = "";
        for (let attempt = 0; attempt < 5; attempt++) {
          roomCode = generateRoomCode();
          const existing = await db
            .select({ id: gameSessions.id })
            .from(gameSessions)
            .where(
              and(
                eq(gameSessions.roomCode, roomCode),
                notInArray(gameSessions.status, ["ended"])
              )
            )
            .limit(1);
          if (!existing.length) break;
        }

        const config = { totalRounds, maxPlayers, packIds, houseRules };

        const [session] = await db
          .insert(gameSessions)
          .values({ roomCode, config, status: "waiting" })
          .returning();

        const [dbPlayer] = await db
          .insert(gamePlayers)
          .values({
            sessionId: session.id,
            userId: jwtPayload ? Number(jwtPayload.sub) : undefined,
            displayName,
            isHost: true,
            isSpectator: false,
          })
          .returning();

        await createGameState(roomCode, config, {
          playerId: String(dbPlayer.id),
          name: displayName,
          userId: jwtPayload?.sub,
        });

        return Response.json({ roomCode, playerId: String(dbPlayer.id) });
      },
    },
  },
});
