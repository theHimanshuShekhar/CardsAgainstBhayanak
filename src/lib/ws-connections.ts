type WsPeer = { send: (data: string) => void; id?: string };

const rooms = new Map<string, Set<WsPeer>>();

export function addConnection(roomCode: string, peer: WsPeer): void {
  if (!rooms.has(roomCode)) rooms.set(roomCode, new Set());
  rooms.get(roomCode)!.add(peer);
}

export function removeConnection(roomCode: string, peer: WsPeer): void {
  rooms.get(roomCode)?.delete(peer);
  if (rooms.get(roomCode)?.size === 0) rooms.delete(roomCode);
}

export function broadcastToRoom(roomCode: string, message: string): void {
  rooms.get(roomCode)?.forEach((peer) => {
    try {
      peer.send(message);
    } catch {
      // Peer disconnected mid-broadcast — ignore
    }
  });
}
