import pino from 'pino'

const isDev = process.env['NODE_ENV'] !== 'production'

type PinoTransport = Parameters<typeof pino.transport>[0]

function buildTransport(): PinoTransport | undefined {
  if (isDev) return { target: 'pino-pretty', options: { colorize: true } }
  if (process.env['AXIOM_TOKEN']) {
    const opts: Record<string, string> = {
      dataset: process.env['AXIOM_DATASET'] ?? 'cab-prod',
      token: process.env['AXIOM_TOKEN'],
    }
    const axiomUrl = process.env['AXIOM_URL']
    if (axiomUrl) {
      // Axiom SDK distinguishes cloud API urls (url) from edge domains (edge).
      // Edge domains must NOT include a scheme — the SDK prepends https://
      // and uses the correct /v1/ingest/ path. Cloud urls include https://.
      if (axiomUrl.startsWith('http')) {
        opts.url = axiomUrl
      } else {
        opts.edge = axiomUrl
      }
    }
    return {
      target: '@axiomhq/pino',
      options: opts,
    }
  }
  return undefined
}

const transport = buildTransport()

export const logger = pino(
  { level: isDev ? 'debug' : 'info' },
  transport ? pino.transport(transport) : undefined,
)

const BASE = 'cab'
export const wsLogger = logger.child({ mod: `${BASE}.ws` })
export const apiLogger = logger.child({ mod: `${BASE}.api` })
export const engineLogger = logger.child({ mod: `${BASE}.engine` })
export const seedLogger = logger.child({ mod: `${BASE}.seed` })
export const sweeperLogger = logger.child({ mod: `${BASE}.sweeper` })
