import pino from 'pino'

const isDev = process.env['NODE_ENV'] !== 'production'

type PinoTransport = Parameters<typeof pino.transport>[0]

function buildTransport(): PinoTransport | undefined {
  if (isDev) return { target: 'pino-pretty', options: { colorize: true } }
  if (process.env['AXIOM_TOKEN']) {
    return {
      target: '@axiomhq/pino',
      options: {
        dataset: process.env['AXIOM_DATASET'] ?? 'cab-prod',
        token: process.env['AXIOM_TOKEN'],
      },
    }
  }
  return undefined
}

const transport = buildTransport()

export const logger = pino(
  { level: isDev ? 'debug' : 'info' },
  transport ? pino.transport(transport) : undefined,
)

export const wsLogger = logger.child({ mod: 'cab.ws' })
export const apiLogger = logger.child({ mod: 'cab.api' })
export const engineLogger = logger.child({ mod: 'cab.engine' })
export const seedLogger = logger.child({ mod: 'cab.seed' })
export const sweeperLogger = logger.child({ mod: 'cab.sweeper' })
