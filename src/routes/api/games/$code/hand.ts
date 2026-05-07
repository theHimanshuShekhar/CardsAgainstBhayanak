import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getRedis } from "../../../../lib/redis";
import { db } from "../../../../db/client";
import { whiteCards } from "../../../../db/schema";
import { inArray } from "drizzle-orm";

export const Route = createFileRoute("/api/games/$code/hand")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const roomCode = params.code.toUpperCase();
        const url = new URL(request.url);
        const HandQuery = z.object({ playerId: z.coerce.string().min(1, "playerId required") });
        const parsed = HandQuery.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) {
          return Response.json({ error: parsed.error.issues[0].message }, { status: 400 });
        }
        const { playerId } = parsed.data;

        const redis = getRedis();
        const cardIds = await redis.smembers(`game:${roomCode}:hand:${playerId}`);
        if (cardIds.length === 0) {
          return Response.json({ cards: [] });
        }

        const rows = await db
          .select({ id: whiteCards.id, text: whiteCards.text })
          .from(whiteCards)
          .where(inArray(whiteCards.id, cardIds.map(Number)));

        return Response.json({
          cards: rows.map((r) => ({ id: String(r.id), text: r.text })),
        });
      },
    },
  },
});
