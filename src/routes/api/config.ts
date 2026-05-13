import { createAPIFileRoute } from '@tanstack/start-api-routes'

export const APIRoute = createAPIFileRoute('/api/config')({
  GET: () =>
    new Response(
      JSON.stringify({
        posthogKey: process.env['POSTHOG_API_KEY'] ?? null,
        posthogHost: process.env['POSTHOG_HOST'] ?? 'https://us.i.posthog.com',
      }),
      {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=3600',
        },
      },
    ),
})
