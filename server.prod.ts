// Production server entry.
//
// TanStack Start v1.167 (Vite/srvx) only emits an SSR fetch handler
// (dist/server/server.js, default export { fetch }); it does not run a
// server or handle WebSockets. We wrap it with srvx's node adapter and
// register crossws so the same port serves HTTP + the game WebSocket.
import { serve } from 'srvx'
import { plugin as ws } from 'crossws/server'
import tssServer from './dist/server/server.js'
import { wsHooks } from './src/ws/handler'
import { ensureServerBoot } from './src/lib/server-boot'

// Seed cards, start the stale-game sweeper and keepalive enforcer.
ensureServerBoot()

const port = Number(process.env['PORT'] ?? 3000)

serve({
  port,
  hostname: '0.0.0.0',
  plugins: [ws(wsHooks)],
  fetch: (request: Request) => tssServer.fetch(request),
})
