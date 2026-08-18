// src/lib/automations/meta-send.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { engineSendText, engineSendTemplate } from './meta-send'

const sendTextMessage = vi.fn(async () => ({ messageId: 'wamid.text' }))
const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.tpl' }))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: (...args: unknown[]) =>
    (sendTextMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))

let db: SupabaseClient
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => db,
}))

interface CapturedWrites {
  message?: Record<string, unknown>
  /** The `id` value queried against the `channels` table, i.e. whatever
   *  resolveChannelForSend passed as `conversationChannelId` — lets
   *  tests assert which channel actually won without mocking
   *  resolveChannelForSend itself. */
  channelIdQueried?: unknown
}

function makeDb(opts: {
  channel?: Record<string, unknown> | null
  metaChannel?: Record<string, unknown> | null
  templates?: Record<string, unknown>[]
  captured: CapturedWrites
  conversationChannelId?: string | null
}): SupabaseClient {
  const contact = { id: 'ct-1', phone: '+15551234567' }
  const conversation = { channel_id: opts.conversationChannelId ?? null }
  return {
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (field: string, value: unknown) => {
          if (table === 'channels' && field === 'id') {
            opts.captured.channelIdQueried = value
          }
          return b
        },
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') opts.captured.message = row
          return b
        },
        update: () => b,
        maybeSingle: async () => {
          if (table === 'contacts') return { data: contact, error: null }
          if (table === 'conversations') return { data: conversation, error: null }
          if (table === 'channels') return { data: opts.channel ?? null, error: null }
          return { data: null, error: null }
        },
        single: async () => {
          if (table === 'meta_channels') {
            return {
              data: opts.metaChannel ?? null,
              error: opts.metaChannel ? null : { message: 'not found' },
            }
          }
          return { data: null, error: null }
        },
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
          if (table === 'message_templates') {
            return resolve({ data: opts.templates ?? [], error: null })
          }
          return resolve({ data: [], error: null })
        },
      }
      return b
    },
  } as unknown as SupabaseClient
}

const FIXTURE = {
  channel: { id: 'ch-1', provider: 'meta' as const },
  metaChannel: { id: 'mc-1', phone_number_id: 'pn-1', access_token: 'tok' },
}

describe('engineSendText', () => {
  it('sends through the resolved channel provider and stamps channel_id', async () => {
    const captured: CapturedWrites = {}
    db = makeDb({ ...FIXTURE, captured })

    const result = await engineSendText({
      accountId: 'acct-1',
      userId: 'u-1',
      conversationId: 'cv-1',
      contactId: 'ct-1',
      text: 'hello',
    })

    expect(result.whatsapp_message_id).toBe('wamid.text')
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pn-1',
        accessToken: 'tok',
        to: '15551234567',
        text: 'hello',
      })
    )
    expect(captured.message?.channel_id).toBe('ch-1')
  })

  it('resolves the explicit channelId ahead of the conversation channel when both are set', async () => {
    const captured: CapturedWrites = {}
    db = makeDb({
      channel: { id: 'ch-override', provider: 'meta' },
      metaChannel: { id: 'mc-1', phone_number_id: 'pn-1', access_token: 'tok' },
      captured,
      conversationChannelId: 'ch-conv',
    })

    await engineSendText({
      accountId: 'acct-1',
      userId: 'u-1',
      conversationId: 'cv-1',
      contactId: 'ct-1',
      text: 'hello',
      channelId: 'ch-override',
    })

    expect(captured.channelIdQueried).toBe('ch-override')
  })

  it('falls back to the conversation channel when channelId is not given (unchanged behavior)', async () => {
    const captured: CapturedWrites = {}
    db = makeDb({
      channel: { id: 'ch-conv', provider: 'meta' },
      metaChannel: { id: 'mc-1', phone_number_id: 'pn-1', access_token: 'tok' },
      captured,
      conversationChannelId: 'ch-conv',
    })

    await engineSendText({
      accountId: 'acct-1',
      userId: 'u-1',
      conversationId: 'cv-1',
      contactId: 'ct-1',
      text: 'hello',
    })

    expect(captured.channelIdQueried).toBe('ch-conv')
  })
})

describe('engineSendTemplate', () => {
  it('sends through the resolved channel provider and stamps channel_id', async () => {
    const captured: CapturedWrites = {}
    db = makeDb({ ...FIXTURE, captured })

    const result = await engineSendTemplate({
      accountId: 'acct-1',
      userId: 'u-1',
      conversationId: 'cv-1',
      contactId: 'ct-1',
      templateName: 'order_update',
      params: ['A123'],
    })

    expect(result.whatsapp_message_id).toBe('wamid.tpl')
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pn-1',
        accessToken: 'tok',
        to: '15551234567',
        templateName: 'order_update',
        params: ['A123'],
      })
    )
    expect(captured.message?.channel_id).toBe('ch-1')
  })

  it('throws when no channel is configured for the account', async () => {
    const captured: CapturedWrites = {}
    db = makeDb({ channel: null, metaChannel: null, captured })

    await expect(
      engineSendTemplate({
        accountId: 'acct-1',
        userId: 'u-1',
        conversationId: 'cv-1',
        contactId: 'ct-1',
        templateName: 'order_update',
      })
    ).rejects.toThrow('WhatsApp not configured for this account')
  })
})
