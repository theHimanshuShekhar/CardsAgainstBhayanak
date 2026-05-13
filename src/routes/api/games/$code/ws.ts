import { createAPIFileRoute } from '@tanstack/start-api-routes'

// WebSocket upgrades are intercepted by the Vite/Node http 'upgrade' event
// before reaching TanStack Start's HTTP handler. This route handles the rare
// case where a plain HTTP request hits this path.
export const APIRoute = createAPIFileRoute('/api/games/$code/ws')({
  GET: () =>
    new Response('WebSocket upgrade required', {
      status: 426,
      headers: { Upgrade: 'websocket' },
    }),
})
