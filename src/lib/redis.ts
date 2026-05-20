import Redis from 'ioredis'
import { logger } from '~/lib/logger'

const url = process.env['REDIS_URL']
if (!url) throw new Error('REDIS_URL not set')

export const redis = new Redis(url!, { maxRetriesPerRequest: 3, lazyConnect: false })

const subscribers = new Map<string, Redis>()
export function getSubscriber(channel: string): Redis {
  let sub = subscribers.get(channel)
  if (!sub) {
    // enableReadyCheck:false — a dedicated subscriber connection that
    // reconnects would otherwise run ioredis's ready-check (an INFO
    // command), which a socket already in subscriber mode rejects with
    // "Connection in subscriber mode" → unhandled rejection → process
    // crash. The error listener keeps a transient blip from being a fatal
    // EventEmitter 'error' (ioredis re-subscribes on reconnect).
    sub = new Redis(url!, { maxRetriesPerRequest: 3, enableReadyCheck: false })
    sub.on('error', (err) => logger.error({ mod: 'cab.redis', channel, err }, 'subscriber error'))
    subscribers.set(channel, sub)
  }
  return sub
}

export const KEYS = {
  game: (code: string) => `game:${code}`,
  players: (code: string) => `game:${code}:players`,
  czarOrder: (code: string) => `game:${code}:czarOrder`,
  round: (code: string) => `game:${code}:round`,
  deckBlack: (code: string) => `game:${code}:deck:black`,
  deckWhite: (code: string) => `game:${code}:deck:white`,
  discardBlack: (code: string) => `game:${code}:discard:black`,
  discardWhite: (code: string) => `game:${code}:discard:white`,
  hand: (code: string, playerId: string) => `game:${code}:hand:${playerId}`,
  grace: (code: string, playerId: string) => `game:${code}:grace:${playerId}`,
  channel: (code: string) => `game:${code}:channel`,
} as const

export const ROOM_TTL_SECONDS = 24 * 60 * 60
