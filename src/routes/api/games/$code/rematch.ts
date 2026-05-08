import { createFileRoute } from "@tanstack/react-router";
import { eq, and } from "drizzle-orm";
import { db } from "../../../../db/client";
import { gameSessions, gamePlayers } from "../../../../db/schema";
import {
  createGameState,
  addPlayerToGame,
  publishEvent,
  type GameConfig,
} from "../../../../lib/game-state";
import { generateRoomCode } from "../../../../lib/room-code";

export const Route = createFileRoute("/api/games/$code/rematch")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        const oldRoomCode = params.code.toUpperCase();

        // Fetch old game session
        const [oldSession] = await db
          .select()
          .from(gameSessions)
          .where(eq(gameSessions.roomCode, oldRoomCode))
          .limit(1);

        if (!oldSession) {
          return Response.json(
            { error: "Game not found" },
            { status: 404 }
          );
        }

        // Fetch all non-spectator players from old game
        const oldPlayers = await db
          .select({
            id: gamePlayers.id,
            userId: gamePlayers.userId,
            displayName: gamePlayers.displayName,
            isHost: gamePlayers.isHost,
          })
          .from(gamePlayers)
          .where(
            and(
              eq(gamePlayers.sessionId, oldSession.id),
              eq(gamePlayers.isSpectator, false)
            )
          );

        if (oldPlayers.length === 0) {
          return Response.json(
            { error: "No players found in old game" },
            { status: 400 }
          );
        }

        // Generate new room code
        let newRoomCode = "";
        for (let attempt = 0; attempt < 5; attempt++) {
          newRoomCode = generateRoomCode();
          const existing = await db
            .select({ id: gameSessions.id })
            .from(gameSessions)
            .where(eq(gameSessions.roomCode, newRoomCode))
            .limit(1);
          if (!existing.length) break;
        }

        // Create new game session with same config
        const config = oldSession.config;
        const [newSession] = await db
          .insert(gameSessions)
          .values({
            roomCode: newRoomCode,
            config,
            status: "waiting",
          })
          .returning();

        // Find host player
        const hostOldPlayer = oldPlayers.find((p) => p.isHost);
        if (!hostOldPlayer) {
          return Response.json(
            { error: "No host found in old game" },
            { status: 400 }
          );
        }

        // Create new players and build ID map
        const playerIdMap: Record<string, string> = {};

        for (const oldPlayer of oldPlayers) {
          const [newPlayer] = await db
            .insert(gamePlayers)
            .values({
              sessionId: newSession.id,
              userId: oldPlayer.userId,
              displayName: oldPlayer.displayName,
              isSpectator: false,
              isHost: oldPlayer.isHost,
            })
            .returning();

          const newPlayerId = String(newPlayer.id);
          playerIdMap[String(oldPlayer.id)] = newPlayerId;
        }

        // Initialize game state in Redis
        const hostNewId = playerIdMap[String(hostOldPlayer.id)];
        await createGameState(newRoomCode, config as GameConfig, {
          playerId: hostNewId,
          name: hostOldPlayer.displayName,
          userId: hostOldPlayer.userId !== null && hostOldPlayer.userId !== undefined
            ? String(hostOldPlayer.userId)
            : undefined,
        });

        // Add non-host players to game state
        for (const oldPlayer of oldPlayers) {
          if (oldPlayer.isHost) continue;
          const newPlayerId = playerIdMap[String(oldPlayer.id)];
          await addPlayerToGame(newRoomCode, newPlayerId, {
            name: oldPlayer.displayName,
            userId: oldPlayer.userId !== null && oldPlayer.userId !== undefined
              ? String(oldPlayer.userId)
              : undefined,
            score: 0,
            isHost: false,
            isSpectator: false,
            isPending: false,
          });
        }

        // Publish rematch event to old room
        await publishEvent(oldRoomCode, "game:rematch", {
          newRoomCode,
          playerIdMap,
        });

        return Response.json({ newRoomCode, playerIdMap });
      },
    },
  },
});
