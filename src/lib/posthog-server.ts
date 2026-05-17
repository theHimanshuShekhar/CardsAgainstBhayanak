import { PostHog } from 'posthog-node'
import { logger } from './logger'
import { getPlayer, getHostId } from './game-state'

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

// Maps a roomCode+playerId to the player's stable PostHog distinct ID
// (`posthogAnonId`, the browser UUID used client-side). Falls back to the
// playerId when the player carries no anonId (e.g. Rando) or Redis is
// unreachable — never throws, so analytics can't break gameplay.
export async function distinctIdFor(code: string, playerId: string): Promise<string> {
  try {
    const player = await getPlayer(code, playerId)
    return player?.posthogAnonId ?? playerId
  } catch {
    return playerId
  }
}

// Game-level events have no single actor; attribute them to the host.
export async function distinctIdForHost(code: string): Promise<string> {
  const hostId = await getHostId(code).catch(() => null)
  return hostId ? distinctIdFor(code, hostId) : code
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
