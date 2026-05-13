import { createAPIFileRoute } from '@tanstack/start-api-routes'
import { authenticate } from '~/lib/api-auth'
import { errorResponse } from '~/lib/api-helpers'

export const APIRoute = createAPIFileRoute('/api/games/$code/leave')({
  POST: async ({ request }) => {
    const auth = await authenticate(request)
    if (!auth) return errorResponse(401, 'not_authorized', 'Missing or invalid token')
    // Phase 9 wires this to game-state.removePlayer + WS broadcast
    return new Response(null, { status: 204 })
  },
})
