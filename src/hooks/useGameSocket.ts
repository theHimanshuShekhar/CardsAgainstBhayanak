import { useEffect, useRef, useState, useCallback } from "react";

export interface GameEvent {
  event: string;
  payload: unknown;
}

export function useGameSocket(roomCode: string | null) {
  const esRef = useRef<EventSource | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<GameEvent | null>(null);
  const handlersRef = useRef<Map<string, (payload: unknown) => void>>(new Map());

  useEffect(() => {
    if (!roomCode) return;

    const es = new EventSource(`/api/games/${roomCode}/events`);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (e) => {
      try {
        const msg: GameEvent = JSON.parse(e.data);
        setLastEvent(msg);
        handlersRef.current.get(msg.event)?.(msg.payload);
        handlersRef.current.get("*")?.(msg);
      } catch {
        // ignore non-JSON (e.g. ping comments)
      }
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, [roomCode]);

  const on = useCallback((event: string, handler: (payload: unknown) => void) => {
    handlersRef.current.set(event, handler);
  }, []);

  return { connected, lastEvent, on };
}
