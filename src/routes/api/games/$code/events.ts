import { createFileRoute } from "@tanstack/react-router";
import { newRedisSubscriber } from "../../../../lib/redis";
import { getGameStatus } from "../../../../lib/game-state";

export const Route = createFileRoute("/api/games/$code/events")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const roomCode = params.code.toUpperCase();

        const status = await getGameStatus(roomCode);
        if (!status) {
          return Response.json({ error: "Room not found" }, { status: 404 });
        }

        const encoder = new TextEncoder();
        let subscriber: ReturnType<typeof newRedisSubscriber> | null = null;

        const stream = new ReadableStream({
          async start(controller) {
            const send = (data: string) => {
              try {
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              } catch {
                // controller closed
              }
            };

            // Keep-alive ping every 25 seconds
            const ping = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": ping\n\n"));
              } catch {
                clearInterval(ping);
              }
            }, 25000);

            subscriber = newRedisSubscriber();
            await subscriber.subscribe(`game:${roomCode}:channel`);
            subscriber.on("message", (_channel: string, message: string) => {
              send(message);
            });

            // Clean up when request is aborted
            request.signal.addEventListener("abort", () => {
              clearInterval(ping);
              if (subscriber) {
                subscriber.unsubscribe().catch(() => {});
                subscriber.quit().catch(() => {});
              }
              try { controller.close(); } catch { /* already closed */ }
            });
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
