import { useEffect, useRef, useState, useCallback } from "react";

export function useGameSocket(roomCode: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef<Map<string, (payload: unknown) => void>>(new Map());
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!roomCode) return;

    let destroyed = false;
    let retryDelay = 1000;

    function connect() {
      if (destroyed) return;

      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${proto}://${window.location.host}/api/games/${roomCode}/ws`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        retryDelay = 1000;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            event: string;
            payload: unknown;
          };
          handlersRef.current.get(msg.event)?.(msg.payload);
          handlersRef.current.get("*")?.(msg);
        } catch {}
      };

      ws.onclose = () => {
        wsRef.current = null;
        setConnected(false);
        if (!destroyed) {
          retryTimerRef.current = setTimeout(() => {
            retryDelay = Math.min(retryDelay * 2, 30_000);
            connect();
          }, retryDelay);
        }
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      destroyed = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
      setConnected(false);
    };
  }, [roomCode]);

  const on = useCallback(
    (event: string, handler: (payload: unknown) => void) => {
      handlersRef.current.set(event, handler);
    },
    []
  );

  return { connected, on };
}
