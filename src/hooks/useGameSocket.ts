import { useCallback, useEffect, useRef, useState } from 'react'
import { TIMING } from '~/lib/timing'
import { captureEvent } from '~/lib/posthog-client'
import type { ServerToClientEvent, ClientToServerEvent } from '~/lib/types'

export function useGameSocket(code: string | null, sessionToken: string | null, anonId: string) {
  const wsRef = useRef<WebSocket | null>(null)
  const synchronizedRef = useRef(false)
  const handlersRef = useRef<((event: ServerToClientEvent) => void)[]>([])
  const [connected, setConnected] = useState(false)
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    if (!code || !sessionToken) return
    let backoffMs = 1000
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let syncTimer: ReturnType<typeof setTimeout> | null = null
    let syncAttempts = 0
    const clearSyncRetry = () => {
      if (syncTimer) clearTimeout(syncTimer)
      syncTimer = null
    }
    let connectTime = 0
    let attempt = 0
    // S2-18: an intentional close (unmount / deps change) must stop the
    // reconnect loop — otherwise a navigated-away socket reconnects forever.
    let cancelled = false
    const isReconnect = () => attempt > 1

    function connect() {
      clearSyncRetry()
      syncAttempts = 0
      attempt++
      const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/api/games/${code}/ws`)
      wsRef.current = ws
      synchronizedRef.current = false

      const requestSnapshot = () => {
        if (
          cancelled ||
          synchronizedRef.current ||
          wsRef.current !== ws ||
          ws.readyState !== WebSocket.OPEN
        )
          return
        clearSyncRetry()
        syncAttempts++
        ws.send(JSON.stringify({ type: 'rejoin' } satisfies ClientToServerEvent))
      }
      ws.onopen = () => {
        connectTime = Date.now()
        setConnected(true)
        captureEvent('cab_ws_connected', { roomCode: code, reconnect: isReconnect() })
        ws.send(
          JSON.stringify({
            type: 'auth',
            sessionToken: sessionToken!,
            anonId,
          } satisfies ClientToServerEvent),
        )
        // rejoin must follow auth_ok, not be pipelined with auth: the
        // server's auth handler is async, so a same-tick rejoin races
        // ahead of it and is rejected as "auth first" (sent below, on
        // the auth_ok message).
        backoffMs = 1000
        pingTimer = setInterval(
          () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'ping' })),
          TIMING.KEEPALIVE_INTERVAL_MS,
        )
      }
      ws.onmessage = (e: MessageEvent<string>) => {
        let event: ServerToClientEvent
        try {
          event = JSON.parse(e.data) as ServerToClientEvent
        } catch {
          return
        }
        if (event.type === 'auth_ok') {
          setAuthed(true)
          requestSnapshot()
        }
        if (event.type === 'auth_error') setAuthed(false)
        if (
          event.type === 'state_snapshot' ||
          (event.type === 'lobby_snapshot' &&
            event.gameStatus !== 'active' &&
            event.gameStatus !== 'paused')
        ) {
          synchronizedRef.current = true
          clearSyncRetry()
        }
        if (
          event.type === 'error' &&
          event.code === 'rate_limited' &&
          !synchronizedRef.current &&
          !syncTimer
        ) {
          if (syncAttempts >= 8) ws.close()
          else
            syncTimer = setTimeout(
              requestSnapshot,
              Math.min(120_000, Math.max(250, event.retryAfterMs ?? 1000)),
            )
        }
        // A session can connect after startGame marks the room active,
        // before startRound creates the first round. That rejoin receives
        // an active lobby snapshot without a hand. The round announcement
        // guarantees the row exists, so finish synchronizing then.
        if (event.type === 'round_started' && !synchronizedRef.current && !syncTimer) {
          requestSnapshot()
        }
        for (const h of handlersRef.current) h(event)
      }
      ws.onclose = () => {
        clearSyncRetry()
        synchronizedRef.current = false
        setConnected(false)
        setAuthed(false)
        if (pingTimer) clearInterval(pingTimer)
        captureEvent('cab_ws_disconnected', {
          roomCode: code,
          durationConnectedMs: connectTime ? Date.now() - connectTime : 0,
        })
        if (cancelled) return
        // S2-19: the first close is the initial disconnect, not a retry.
        if (attempt > 1)
          captureEvent('cab_reconnect_attempt', { roomCode: code, attempt, backoffMs })
        reconnectTimer = setTimeout(connect, backoffMs)
        backoffMs = Math.min(30_000, backoffMs * 2)
      }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => {
      cancelled = true
      clearSyncRetry()
      wsRef.current?.close()
      if (pingTimer) clearInterval(pingTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }, [code, sessionToken, anonId])

  const send = (event: ClientToServerEvent) => {
    const ws = wsRef.current
    if (!authed || !synchronizedRef.current || !ws || ws.readyState !== WebSocket.OPEN) {
      return { ok: false as const, message: 'Disconnected. Reconnect and try again.' }
    }
    try {
      ws.send(JSON.stringify(event))
      return { ok: true as const }
    } catch {
      return { ok: false as const, message: 'Could not send. Try again.' }
    }
  }
  // Stable identity: the consumer's subscription effect must not tear down
  // and re-add its handler every render. A re-subscribe has a window between
  // passive-effect cleanup and setup where handlersRef is empty, and any WS
  // frame arriving then (e.g. a staggered card_revealed) is silently dropped.
  const on = useCallback((handler: (e: ServerToClientEvent) => void) => {
    handlersRef.current.push(handler)
    return () => {
      handlersRef.current = handlersRef.current.filter((h) => h !== handler)
    }
  }, [])

  const reconnect = useCallback(() => {
    synchronizedRef.current = false
    setConnected(false)
    setAuthed(false)
    wsRef.current?.close()
  }, [])

  return { connected, authed, send, on, reconnect }
}
