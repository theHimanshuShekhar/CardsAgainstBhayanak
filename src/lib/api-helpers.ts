import { z } from 'zod'
import type { ErrorCode } from './types'

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): Response {
  return new Response(JSON.stringify({ error: message, code, details }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function getClientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0] ??
    'unknown'
  )
}

export const GameConfigSchema = z.object({
  maxPlayers: z.number().int().min(3).max(10),
  roundsToWin: z.number().int().min(3).max(20),
  timer: z.enum(['30s', '60s', '90s', 'Off']),
  packs: z.array(z.string()).min(1),
  rules: z.array(
    z.enum([
      'godmode',
      'survival',
      'serious_business',
      'rebooting',
      'packing_heat',
      'rando',
      'never_have_i_ever',
      'happy_ending',
    ]),
  ),
})

// Modal rules are mutually exclusive (≤ 1 active). The UI enforces this
// with a radio group, but every endpoint that accepts a GameConfig must
// re-check it server-side — a crafted request bypasses the client.
// Shared by create and config-patch so they cannot diverge.
const MODAL_RULE_IDS = ['godmode', 'survival', 'serious_business'] as const

export function conflictingModalRules(rules: readonly string[]): string[] {
  return rules.filter((r) => (MODAL_RULE_IDS as readonly string[]).includes(r))
}

export const CreateGameSchema = z.object({
  username: z.string().min(2).max(20).trim(),
  anonId: z.string().min(1),
  config: GameConfigSchema,
})

export const JoinGameSchema = z.object({
  username: z.string().min(2).max(20).trim(),
  anonId: z.string().min(1),
  role: z.enum(['player', 'spectator']),
})
