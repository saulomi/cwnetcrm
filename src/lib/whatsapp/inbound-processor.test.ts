import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  findExistingContact: vi.fn(),
  reopenClosedConversation: vi.fn(),
  state: {
    conversationRows: [] as Record<string, unknown>[],
    conversationUpdateCalls: [] as Record<string, unknown>[],
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    priorCustomerMsgCount: 0,
    replyContextParent: null as { id: string } | null,
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    broadcastRecipients: [] as Record<string, unknown>[],
    messageReactionCalls: { upserts: [] as Record<string, unknown>[], deletes: 0 },
    statusRecipient: null as { id: string; status: string } | null,
    statusMsgRow: null as { conversation_id: string; conversations: { account_id: string } } | null,
    broadcastRecipientUpdateCalls: [] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: h.findExistingContact,
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/conversations/reopen', () => ({
  reopenClosedConversation: h.reopenClosedConversation,
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))

import {
  processInboundMessage,
  handleStatusUpdate,
  type NormalizedInboundMessage,
} from './inbound-processor'

function fakeDb(): SupabaseClient {
  return {
    from(table: string) {
      switch (table) {
        case 'contacts':
          return {
            insert: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: { id: 'contact-1', name: 'Ada', phone: '15551230000' }, error: null }),
              }),
            }),
          }
        case 'conversations':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({ data: h.state.conversationRows, error: null }),
                  }),
                }),
              }),
            }),
            insert: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: { id: 'conv-1', channel_id: null }, error: null }),
              }),
            }),
            update: (row: Record<string, unknown>) => {
              h.state.conversationUpdateCalls.push(row)
              return { eq: () => Promise.resolve({ error: null }) }
            },
          }
        case 'messages':
          return {
            select: (columns: string, options?: { head?: boolean }) => {
              if (options?.head) {
                return {
                  eq: () => ({
                    eq: () =>
                      Promise.resolve({ count: h.state.priorCustomerMsgCount, error: null }),
                  }),
                }
              }
              if (columns.includes('conversations(')) {
                // handleStatusUpdate's msgRow lookup.
                return {
                  eq: () => ({
                    limit: () => ({
                      maybeSingle: () =>
                        Promise.resolve({ data: h.state.statusMsgRow, error: null }),
                    }),
                  }),
                }
              }
              // lookupInternalIdByWaId
              return {
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () =>
                      Promise.resolve({ data: h.state.replyContextParent, error: null }),
                  }),
                }),
              }
            },
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options })
              return {
                select: () =>
                  Promise.resolve({ data: h.state.messageUpsertResult, error: null }),
              }
            },
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          }
        case 'broadcast_recipients':
          return {
            select: (columns: string) => {
              if (columns.includes('broadcasts!inner')) {
                // flagBroadcastReplyIfAny
                return {
                  eq: () => ({
                    eq: () => ({
                      in: () => ({
                        order: () => ({
                          limit: () =>
                            Promise.resolve({ data: h.state.broadcastRecipients, error: null }),
                        }),
                      }),
                    }),
                  }),
                }
              }
              // handleStatusUpdate
              return {
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: h.state.statusRecipient, error: null }),
                }),
              }
            },
            update: (row: Record<string, unknown>) => {
              h.state.broadcastRecipientUpdateCalls.push(row)
              return { eq: () => Promise.resolve({ error: null }) }
            },
          }
        case 'message_reactions':
          return {
            upsert: (row: Record<string, unknown>) => {
              h.state.messageReactionCalls.upserts.push(row)
              return Promise.resolve({ error: null })
            },
            delete: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => {
                    h.state.messageReactionCalls.deletes++
                    return Promise.resolve({ error: null })
                  },
                }),
              }),
            }),
          }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    },
  } as unknown as SupabaseClient
}

const BASE_MSG: NormalizedInboundMessage = {
  channelId: 'ch-1',
  accountId: 'acc-1',
  configOwnerUserId: 'user-1',
  from: '15551230000',
  contactName: 'Ada',
  waMessageId: 'wamid.TEST1',
  timestamp: '1700000000',
  type: 'text',
  text: 'hello',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.conversationRows = []
  h.state.conversationUpdateCalls = []
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.upsertCalls = []
  h.state.priorCustomerMsgCount = 0
  h.state.replyContextParent = null
  h.state.rpcCalls = []
  h.state.broadcastRecipients = []
  h.state.messageReactionCalls = { upserts: [], deletes: 0 }
  h.state.statusRecipient = null
  h.state.statusMsgRow = null
  h.state.broadcastRecipientUpdateCalls = []
  h.findExistingContact.mockResolvedValue({ id: 'contact-1', name: 'Ada', phone: '15551230000' })
  h.reopenClosedConversation.mockResolvedValue(false)
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockResolvedValue(undefined)
})

describe('processInboundMessage', () => {
  it('processes a genuine first delivery: stamps channel, pins conversation, fans out', async () => {
    const db = fakeDb()
    const result = await processInboundMessage(db, BASE_MSG)

    expect(result).toEqual({ consumed: false })
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      channel_id: 'ch-1',
      content_type: 'text',
      content_text: 'hello',
      message_id: 'wamid.TEST1',
    })
    expect(h.state.conversationUpdateCalls).toContainEqual({ channel_id: 'ch-1' })
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      db,
      'acc-1',
      'conversation.created',
      expect.objectContaining({ contact_id: 'contact-1' }),
    )
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      db,
      'acc-1',
      'message.received',
      expect.objectContaining({ whatsapp_message_id: 'wamid.TEST1' }),
    )
  })

  it('skips the channel pin write when the conversation already points at this channel', async () => {
    h.state.conversationRows = [{ id: 'conv-2', channel_id: 'ch-1', account_id: 'acc-1' }]
    const db = fakeDb()
    await processInboundMessage(db, BASE_MSG)
    expect(h.state.conversationUpdateCalls).toHaveLength(0)
  })

  it('a replayed delivery is a no-op past the insert', async () => {
    h.state.conversationRows = [{ id: 'conv-2', channel_id: 'ch-1', account_id: 'acc-1' }]
    h.state.messageUpsertResult = []
    const db = fakeDb()
    const result = await processInboundMessage(db, BASE_MSG)

    expect(result).toEqual({ consumed: false })
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('stores an inbound reaction without touching messages', async () => {
    h.state.conversationRows = [{ id: 'conv-2', channel_id: 'ch-1', account_id: 'acc-1' }]
    h.state.replyContextParent = { id: 'internal-msg-1' }
    const db = fakeDb()
    const result = await processInboundMessage(db, {
      ...BASE_MSG,
      type: 'reaction',
      text: undefined,
      replyToWaMessageId: 'wamid.TARGET',
      reactionEmoji: '👍',
    })

    expect(result).toEqual({ consumed: false })
    expect(h.state.upsertCalls).toHaveLength(0)
    expect(h.state.messageReactionCalls.upserts).toEqual([
      expect.objectContaining({ message_id: 'internal-msg-1', emoji: '👍' }),
    ])
  })

  it('removes a reaction when the emoji is absent', async () => {
    h.state.conversationRows = [{ id: 'conv-2', channel_id: 'ch-1', account_id: 'acc-1' }]
    h.state.replyContextParent = { id: 'internal-msg-1' }
    const db = fakeDb()
    await processInboundMessage(db, {
      ...BASE_MSG,
      type: 'reaction',
      text: undefined,
      replyToWaMessageId: 'wamid.TARGET',
      reactionEmoji: undefined,
    })

    expect(h.state.messageReactionCalls.deletes).toBe(1)
  })

  it('routes an interactive reply to flows with the reply_id/title shape', async () => {
    h.state.conversationRows = [{ id: 'conv-2', channel_id: 'ch-1', account_id: 'acc-1' }]
    const db = fakeDb()
    await processInboundMessage(db, {
      ...BASE_MSG,
      type: 'interactive',
      text: 'Existing customer',
      interactiveReplyId: 'OPT_EXISTING',
    })

    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          kind: 'interactive_reply',
          reply_id: 'OPT_EXISTING',
          reply_title: 'Existing customer',
          meta_message_id: 'wamid.TEST1',
        },
      }),
    )
  })
})

describe('handleStatusUpdate', () => {
  it('mirrors a valid forward transition onto broadcast_recipients and fans out', async () => {
    h.state.statusRecipient = { id: 'rec-1', status: 'sent' }
    h.state.statusMsgRow = { conversation_id: 'conv-1', conversations: { account_id: 'acc-1' } }
    const db = fakeDb()

    await handleStatusUpdate(db, {
      id: 'wamid.TEST1',
      status: 'delivered',
      timestamp: '1700000000',
      recipient_id: '15551230000',
    })

    expect(h.state.broadcastRecipientUpdateCalls).toEqual([
      expect.objectContaining({ status: 'delivered', delivered_at: expect.any(String) }),
    ])
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      db,
      'acc-1',
      'message.status_updated',
      expect.objectContaining({ status: 'delivered', whatsapp_message_id: 'wamid.TEST1' }),
    )
  })

  it('refuses to regress a recipient past a terminal state', async () => {
    h.state.statusRecipient = { id: 'rec-1', status: 'read' }
    h.state.statusMsgRow = null
    const db = fakeDb()

    await handleStatusUpdate(db, {
      id: 'wamid.TEST1',
      status: 'failed',
      timestamp: '1700000000',
      recipient_id: '15551230000',
    })

    expect(h.state.broadcastRecipientUpdateCalls).toHaveLength(0)
  })
})
