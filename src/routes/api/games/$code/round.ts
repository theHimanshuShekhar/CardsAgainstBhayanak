import { createFileRoute } from "@tanstack/react-router";
import { getRedis } from "../../../../lib/redis";
import { db } from "../../../../db/client";
import { blackCards } from "../../../../db/schema";
import { inArray } from "drizzle-orm";

export const Route = createFileRoute("/api/games/$code/round")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const roomCode = params.code.toUpperCase();
        const redis = getRedis();
        const round = await redis.hgetall(`game:${roomCode}:round`);

        if (!round || !round.blackCardId) {
          return Response.json({ round: null });
        }

        const [card] = await db
          .select({ id: blackCards.id, text: blackCards.text, pick: blackCards.pick })
          .from(blackCards)
          .where(inArray(blackCards.id, [Number(round.blackCardId)]));

        return Response.json({
          round: {
            czarId: round.czarId ?? "",
            blackCard: card ? { id: card.id, text: card.text, pick: card.pick } : null,
          },
        });
      },
    },
  },
});
