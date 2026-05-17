// Production server entry.
//
// TanStack Start v1.167 (Vite/srvx) only emits an SSR fetch handler
// (dist/server/server.js, default export { fetch }); it does not run a
// server or handle WebSockets. We wrap it with srvx's node adapter and
// register crossws so the same port serves HTTP + the game WebSocket.
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { serve } from 'srvx'
import { plugin as ws } from 'crossws/server'
import tssServer from './dist/server/server.js'
import { wsHooks } from './src/ws/handler'
import { ensureServerBoot } from './src/lib/server-boot'

// Seed cards, start the stale-game sweeper and keepalive enforcer.
ensureServerBoot()

const port = Number(process.env['PORT'] ?? 3000)

// The TSS SSR handler only renders HTML — it never serves the client
// bundle. Vite emits the hashed JS/CSS under dist/client/assets, so in
// prod we serve /assets/* ourselves; everything else goes to SSR.
const ASSETS_DIR = resolve('./dist/client/assets')
const ASSET_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
}

async function serveAsset(pathname: string): Promise<Response> {
  const filePath = resolve(join(ASSETS_DIR, pathname.slice('/assets/'.length)))
  // Reject path traversal: the resolved file must stay under ASSETS_DIR.
  if (filePath !== ASSETS_DIR && !filePath.startsWith(ASSETS_DIR + sep)) {
    return new Response('Not found', { status: 404 })
  }
  try {
    const body = await readFile(filePath)
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1)
    return new Response(body, {
      headers: {
        'content-type': ASSET_TYPES[ext] ?? 'application/octet-stream',
        // Filenames are content-hashed, so they can cache forever.
        'cache-control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

serve({
  port,
  hostname: '0.0.0.0',
  plugins: [ws(wsHooks)],
  fetch: (request: Request) => {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/assets/')) return serveAsset(pathname)
    return tssServer.fetch(request)
  },
})
