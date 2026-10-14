import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import '~/styles.css'
import { getSiteOrigin } from '~/lib/site-origin'
import { shareHead } from '~/lib/share-head'
import { GameProvider } from '~/contexts/GameContext'
import { initPostHog } from '~/lib/posthog-client'

export const Route = createRootRoute({
  loader: () => getSiteOrigin(),
  head: ({ loaderData, matches }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ...shareHead(loaderData ?? 'http://localhost:3000', matches.at(-1)?.pathname ?? '/').meta,
    ],
    links: [
      ...shareHead(loaderData ?? 'http://localhost:3000', matches.at(-1)?.pathname ?? '/').links,
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-v1.png' },
      { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon-v1.png' },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: '' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700;800;900&family=Geist+Mono:wght@400;500;600&family=Bricolage+Grotesque:wght@500;700;800;900&display=swap',
      },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  useEffect(() => {
    initPostHog()
  }, [])
  return (
    <RootDocument>
      <GameProvider>
        <Outlet />
      </GameProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
