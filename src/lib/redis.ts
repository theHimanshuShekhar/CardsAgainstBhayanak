import Redis from 'ioredis'

const url = process.env['REDIS_URL']
if (!url) throw new Error('REDIS_URL not set')

export const redis = new Redis(url!, { maxRetriesPerRequest: 3, lazyConnect: false })

const subscribers = new Map<string, Redis>()
export function getSubscriber(channel: string): Redis {
  let sub = subscribers.get(channel)
  if (!sub) {
    sub = new Redis(url!, { maxRetriesPerRequest: 3 })
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
