import { useEffect, useRef, useState } from 'react'
import { TIMING } from '~/lib/timing'
import { captureEvent } from '~/lib/posthog-client'
import type { ServerToClientEvent, ClientToServerEvent } from '~/lib/types'

export function useGameSocket(code: string | null, sessionToken: string | null, anonId: string) {
  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<((event: ServerToClientEvent) => void)[]>([])
  const [connected, setConnected] = useState(false)
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    if (!code || !sessionToken) return
    let backoffMs = 1000
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let connectTime = 0
    let attempt = 0
    const isReconnect = () => attempt > 1

    function connect() {
      attempt++
      const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/api/games/${code}/ws`)
      wsRef.current = ws

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
        ws.send(JSON.stringify({ type: 'rejoin' } satisfies ClientToServerEvent))
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
        if (event.type === 'auth_ok') setAuthed(true)
        for (const h of handlersRef.current) h(event)
      }
      ws.onclose = () => {
        setConnected(false)
        setAuthed(false)
        if (pingTimer) clearInterval(pingTimer)
        captureEvent('cab_ws_disconnected', {
          roomCode: code,
          durationConnectedMs: connectTime ? Date.now() - connectTime : 0,
        })
        captureEvent('cab_reconnect_attempt', { roomCode: code, attempt, backoffMs })
        setTimeout(connect, backoffMs)
        backoffMs = Math.min(30_000, backoffMs * 2)
      }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => {
      wsRef.current?.close()
      if (pingTimer) clearInterval(pingTimer)
    }
  }, [code, sessionToken, anonId])

  const send = (event: ClientToServerEvent) => wsRef.current?.send(JSON.stringify(event))
  const on = (handler: (e: ServerToClientEvent) => void) => {
    handlersRef.current.push(handler)
    return () => {
      handlersRef.current = handlersRef.current.filter((h) => h !== handler)
    }
  }

  return { connected, authed, send, on }
}
