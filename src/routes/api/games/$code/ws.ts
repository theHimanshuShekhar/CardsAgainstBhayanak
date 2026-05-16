import { createFileRoute } from '@tanstack/react-router'

// WebSocket upgrades are handled by Nitro's crossws engine (see
// src/ws/ws-route.ts). This HTTP handler only responds to the rare
// case where a plain HTTP request hits this path without upgrading.
export const Route = createFileRoute('/api/games/$code/ws')({
  server: {
    handlers: {
      GET: () =>
        new Response('WebSocket upgrade required', {
          status: 426,
          headers: { Upgrade: 'websocket' },
        }),
    },
  },
})
