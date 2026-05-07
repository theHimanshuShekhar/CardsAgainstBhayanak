import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { attachWebSocketHandler } from './src/ws/handler'

function gameWsPlugin(): Plugin {
  return {
    name: 'game-websocket',
    configureServer(server) {
      if (server.httpServer) attachWebSocketHandler(server.httpServer)
    },
  }
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    gameWsPlugin(),
  ],
})

export default config
