import { z } from 'zod'
import type { ClientToServerEvent } from '~/lib/types'

const id = z.string().min(1).max(256)
const ids = z.array(id).min(1).max(3)

// Validate untrusted frames before accessing fields or calling the engine.
// Limits cover the largest legal play/ranking and keep payloads bounded.
export const ClientMessageSchema: z.ZodType<ClientToServerEvent> = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('auth'),
    sessionToken: z.string().min(1).max(4096),
    anonId: id.optional(),
  }),
  z.strictObject({ type: z.literal('rejoin') }),
  z.strictObject({ type: z.literal('play'), cardIds: ids, commandId: id.optional() }),
  z.strictObject({ type: z.literal('gamble') }),
  z.strictObject({ type: z.literal('pick'), submissionId: id, commandId: id.optional() }),
  z.strictObject({ type: z.literal('rank'), ranking: ids }),
  z.strictObject({ type: z.literal('vote'), submissionId: id, commandId: id.optional() }),
  z.strictObject({ type: z.literal('eliminate'), submissionId: id }),
  z.strictObject({ type: z.literal('redraw') }),
  z.strictObject({ type: z.literal('confess_discard'), cardId: id }),
  z.strictObject({ type: z.literal('happy_ending') }),
  z.strictObject({ type: z.literal('leave') }),
  z.strictObject({ type: z.literal('ping') }),
])
