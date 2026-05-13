import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

function websocketPlugin(): Plugin {
  return {
    name: 'cab-websocket',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        // Dynamically import to avoid loading Redis/DB at build time
        if (process.env['NODE_ENV'] !== 'test') {
          void import('./src/lib/sweeper').then(({ startSweeper }) => startSweeper())
        }
        void import('./src/ws/handler').then(({ wsHooks, startKeepaliveEnforcer }) => {
          if (process.env['NODE_ENV'] !== 'test') startKeepaliveEnforcer()
          void import('crossws/adapters/node').then(({ default: nodeAdapter }) => {
            const adapter = nodeAdapter({ hooks: wsHooks })
            server.httpServer!.on('upgrade', (req, socket, head) => {
              if (req.url?.includes('/ws')) {
                void adapter.handleUpgrade(req, socket as never, head as never)
              }
            })
          })
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [
    tsConfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    websocketPlugin(),
  ],
})
