// Production server entry.
//
// TanStack Start v1.167 (Vite/srvx) only emits an SSR fetch handler
// (dist/server/server.js, default export { fetch }); it does not run a
// server or handle WebSockets. We wrap it with srvx's node adapter and
// register crossws so the same port serves HTTP + the game WebSocket.
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { serve } from 'srvx'
// Validate the ingress allowlist before listening, including when API route
// chunks have not yet been loaded by the SSR handler.
import './src/lib/client-identity.server'

import { readSiteOrigin } from './src/lib/site-origin.server'

readSiteOrigin()

import { waitForSchema } from './src/lib/schema-startup'

const port = Number(process.env['PORT'] ?? 3000)
await waitForSchema(port)
// Load modules that start seeding/jobs only after compatibility succeeds.
const { gameWebSocketPlugin } = await import('./src/ws/server')
const { default: tssServer } = await import('./dist/server/server.js')

// The TSS SSR handler only renders HTML — it never serves the client
// bundle. Vite emits the hashed JS/CSS under dist/client/assets, so in
// prod we serve /assets/* ourselves; everything else goes to SSR.
const PUBLIC_FILES = new Set([
  '/share-v1.png',
  '/favicon-v1.png',
  '/apple-touch-icon-v1.png',
  '/favicon.svg',
])
const CLIENT_DIR = resolve('./dist/client')
const ASSETS_DIR = resolve('./dist/client/assets')
const ASSET_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
}

async function serveAsset(pathname: string): Promise<Response> {
  const base = PUBLIC_FILES.has(pathname) ? CLIENT_DIR : ASSETS_DIR
  const relative = PUBLIC_FILES.has(pathname)
    ? pathname.slice(1)
    : pathname.slice('/assets/'.length)
  const filePath = resolve(join(base, relative))
  // Reject path traversal: the resolved file must stay under ASSETS_DIR.
  if (filePath !== base && !filePath.startsWith(base + sep)) {
    return new Response('Not found', { status: 404 })
  }
  try {
    const body = await readFile(filePath)
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1)
    return new Response(body, {
      headers: {
        'content-type': ASSET_TYPES[ext] ?? 'application/octet-stream',
        // Filenames are content-hashed, so they can cache forever.
        'cache-control':
          pathname === '/favicon.svg'
            ? 'public, max-age=3600'
            : 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

serve({
  port,
  hostname: '0.0.0.0',
  plugins: [gameWebSocketPlugin],
  fetch: (request: Request) => {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/assets/') || PUBLIC_FILES.has(pathname)) return serveAsset(pathname)
    return tssServer.fetch(request)
  },
})
