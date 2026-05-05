import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { submitCards } from "../../../../lib/game-engine";

const PlayBody = z.object({
  playerId: z.string(),
  cardIds: z.array(z.string()).min(1).max(3),
});

export const Route = createFileRoute("/api/games/$code/play")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const roomCode = params.code.toUpperCase();
        const body = await request.json();
        const parsed = PlayBody.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: parsed.error.issues[0].message },
            { status: 400 }
          );
        }

        try {
          const { allPlayed } = await submitCards(
            roomCode,
            parsed.data.playerId,
            parsed.data.cardIds
          );
          return Response.json({ ok: true, allPlayed });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return Response.json({ error: message }, { status: 422 });
        }
      },
    },
  },
});
