import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tanstackStart({ routeFileIgnorePattern: "\\.(test|spec)\\.(ts|tsx)$" } as any),
    viteReact(),
  ],
})

export default config
