import { PostHog } from 'posthog-node'
import { logger } from './logger'

const apiKey = process.env['POSTHOG_API_KEY']
const host = process.env['POSTHOG_HOST'] ?? 'https://us.i.posthog.com'

let client: PostHog | null = null
if (apiKey) {
  client = new PostHog(apiKey, { host, flushAt: 20, flushInterval: 10_000 })
}

export function captureServerEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (!client) return
  try {
    client.capture({ distinctId, event, properties })
  } catch (err) {
    logger.error({ err, event }, 'posthog capture failed')
  }
}

export function captureServerException(
  distinctId: string,
  err: unknown,
  properties?: Record<string, unknown>,
): void {
  if (!client) return
  try {
    client.captureException(
      err instanceof Error ? err : new Error(String(err)),
      distinctId,
      properties,
    )
  } catch (e) {
    logger.error({ e }, 'posthog captureException failed')
  }
}

export async function shutdownPostHog(): Promise<void> {
  await client?.shutdown()
}
