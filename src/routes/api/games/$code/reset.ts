import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db'
import { gameSessions } from '~/db/schema'
import { authenticate } from '~/lib/api-auth'
import { errorResponse } from '~/lib/api-helpers'
import { apiLogger } from '~/lib/logger'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import * as engine from '~/lib/game-engine'

const ResetRequestSchema = z.object({ mode: z.enum(['rematch', 'lobby']) })

export const Route = createFileRoute('/api/games/$code/reset')({
  server: {
    handlers: {
      // #3: host replays the same room after game_over — 'rematch' starts
      // a fresh game immediately, 'lobby' returns everyone to the lobby.
      POST: async ({ request, params }) => {
        const auth = await authenticate(request, params.code.toUpperCase())
        if (!auth) return errorResponse(401, 'not_authorized', 'Missing or invalid token')

        const code = params.code.toUpperCase()

        let body: unknown
        try {
          body = await request.json()
        } catch {
          return errorResponse(400, 'internal_error', 'Invalid JSON body')
        }
        const parsed = ResetRequestSchema.safeParse(body)
        if (!parsed.success)
          return errorResponse(400, 'internal_error', "mode must be 'rematch' or 'lobby'")
        const { mode } = parsed.data

        const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
        if (!session) return errorResponse(404, 'room_not_found', 'Room not found')
        if (session.hostPlayerId !== auth.playerId)
          return errorResponse(403, 'host_only', 'Only the host can reset the game')
        // Guards a double-reset race: only the first request finds 'ended'.
        if (session.status !== 'ended')
          return errorResponse(409, 'invalid_state', 'Game is not over')

        if (!(await authenticate(request, code)))
          return errorResponse(401, 'not_authorized', 'Missing or invalid token')
        await engine.resetGame(code, mode, auth.playerId)
        apiLogger.info({ roomCode: code, mode }, 'game reset')
        return new Response(null, { status: 204 })
      },
    },
  },
})
