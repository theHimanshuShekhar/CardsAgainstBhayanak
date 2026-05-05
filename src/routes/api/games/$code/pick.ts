import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { pickWinner } from "../../../../lib/game-engine";

const PickBody = z.object({
  czarPlayerId: z.string(),
  winningSubmissionId: z.string(),
});

export const Route = createFileRoute("/api/games/$code/pick")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const roomCode = params.code.toUpperCase();
        const body = await request.json();
        const parsed = PickBody.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: parsed.error.issues[0].message },
            { status: 400 }
          );
        }

        try {
          await pickWinner(
            roomCode,
            parsed.data.czarPlayerId, // validated but czar auth is implicit
            parsed.data.winningSubmissionId
          );
          return Response.json({ ok: true });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return Response.json({ error: message }, { status: 422 });
        }
      },
    },
  },
});
