import { createFileRoute } from '@tanstack/react-router'
import { authenticate } from '~/lib/api-auth'
import { errorResponse } from '~/lib/api-helpers'
import * as engine from '~/lib/game-engine'

export const Route = createFileRoute('/api/games/$code/leave')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticate(request)
        if (!auth) return errorResponse(401, 'not_authorized', 'Missing or invalid token')
        // S2-6: explicit leave outside the WS (sendBeacon on unload).
        // Run the same immediate drop path as the WS `leave` message;
        // dropPlayer is idempotent so a racing WS close is harmless.
        await engine.dropPlayer(auth.roomCode, auth.playerId, 'leave')
        return new Response(null, { status: 204 })
      },
    },
  },
})
