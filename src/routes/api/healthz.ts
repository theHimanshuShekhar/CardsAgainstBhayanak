import { createFileRoute } from '@tanstack/react-router'
import { healthResponse } from '~/lib/health'

export const Route = createFileRoute('/api/healthz')({
  server: {
    handlers: {
      GET: healthResponse,
    },
  },
})
