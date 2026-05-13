import { createAPIFileRoute } from '@tanstack/start-api-routes'
import { db } from '~/db'
import { packs } from '~/db/schema'

export const APIRoute = createAPIFileRoute('/api/packs')({
  GET: async () => {
    const rows = await db.select().from(packs).orderBy(packs.name)
    return new Response(JSON.stringify({ packs: rows }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    })
  },
})
