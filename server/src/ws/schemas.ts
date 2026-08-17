import { z } from 'zod'

/**
 * Schemas for CLIENT→SERVER WebSocket frames. The hub previously trusted
 * JSON.parse + a bare `as WsMessage` cast, so any garbage (wrong types, huge
 * payloads, unknown frames) flowed straight into the subscribe/unsubscribe
 * routing. These schemas reject malformed frames with a single safeParse.
 */

export const wsAuthSchema = z.object({
  type: z.literal('auth'),
  token: z.string().min(1),
})

export const wsSubscribeSchema = z.object({
  type: z.literal('subscribe'),
  channel: z.string().min(1).max(512),
})

export const wsUnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  channel: z.string().min(1).max(512),
})

export const inboundWsSchema = z.discriminatedUnion('type', [
  wsAuthSchema,
  wsSubscribeSchema,
  wsUnsubscribeSchema,
])

export type InboundWsMessage = z.infer<typeof inboundWsSchema>