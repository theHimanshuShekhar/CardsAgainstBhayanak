import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db'
import { packs } from '~/db/schema'

export const Route = createFileRoute('/api/packs')({
  server: {
    handlers: {
      GET: async () => {
        const rows = await db.select().from(packs).orderBy(packs.name)
        return new Response(JSON.stringify({ packs: rows }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
        })
      },
    },
  },
})
