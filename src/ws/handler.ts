import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

interface UpgradeEmitter {
  on(
    event: "upgrade",
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  ): this;
}
import { newRedisSubscriber } from "../lib/redis";
import { getFullGameState } from "../lib/game-state";
import type { Redis } from "ioredis";

const roomPeers = new Map<string, Set<WebSocket>>();
const roomSubs = new Map<string, Redis>();

function parseRoomCode(req: IncomingMessage): string | null {
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    const m = url.pathname.match(/^\/api\/games\/([A-Za-z0-9]+)\/ws$/);
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

async function handlePeer(ws: WebSocket, roomCode: string) {
  if (!roomPeers.has(roomCode)) roomPeers.set(roomCode, new Set());
  roomPeers.get(roomCode)!.add(ws);

  if (!roomSubs.has(roomCode)) {
    const sub = newRedisSubscriber();
    await sub.subscribe(`game:${roomCode}:channel`);
    sub.on("message", (_ch, msg) => {
      for (const peer of roomPeers.get(roomCode) ?? []) {
        if (peer.readyState === WebSocket.OPEN) peer.send(msg);
      }
    });
    roomSubs.set(roomCode, sub);
  }

  try {
    const snapshot = await getFullGameState(roomCode);
    ws.send(JSON.stringify({ event: "game:snapshot", payload: snapshot }));
  } catch {}

  ws.on("close", async () => {
    roomPeers.get(roomCode)?.delete(ws);
    if (!roomPeers.get(roomCode)?.size) {
      roomPeers.delete(roomCode);
      const sub = roomSubs.get(roomCode);
      if (sub) {
        await sub.unsubscribe().catch(() => {});
        await sub.quit().catch(() => {});
        roomSubs.delete(roomCode);
      }
    }
  });
}

export function attachWebSocketHandler(httpServer: UpgradeEmitter): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const roomCode = parseRoomCode(req);
    if (!roomCode) return; // let Vite HMR and other handlers proceed

    wss.handleUpgrade(req, socket, head, (ws) => {
      handlePeer(ws, roomCode).catch(console.error);
    });
  });
}
