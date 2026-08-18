import { describe, it, expect, vi } from 'vitest'

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: db, accountId: 'acc-1', userId: 'user-1', role: 'agent', account: { id: 'acc-1', name: 'Acc' } })),
  toErrorResponse: (err: unknown) => ({ body: { error: String(err) }, init: { status: 500 } }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => ({ body: { error: 'rate limited' }, init: { status: 429 } }),
  RATE_LIMITS: { react: {} },
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))
vi.mock('@/lib/whatsapp/phone-utils', () => ({ sanitizePhoneForMeta: (p: string) => p }))

const sendReactionMessage = vi.fn(async () => ({}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendReactionMessage: (...args: unknown[]) => (sendReactionMessage as unknown as (...a: unknown[]) => unknown)(...args),
}))

let resolvedProvider: 'meta' | 'uazapi' = 'meta'
vi.mock('@/lib/whatsapp/channel-resolution', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp/channel-resolution')>(
    '@/lib/whatsapp/channel-resolution'
  )
  return {
    ...actual,
    resolveChannelForSend: vi.fn(async () => ({ channelId: 'ch-1', provider: resolvedProvider })),
  }
})

const db = {
  from: (table: string) => {
    if (table === 'messages') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'msg-1', message_id: 'wamid.1', conversation_id: 'conv-1' }, error: null }) }) }) }
    }
    if (table === 'conversations') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { id: 'conv-1', account_id: 'acc-1', channel_id: 'ch-1', contact: { phone: '+15551230000' } }, error: null }),
            }),
          }),
        }),
      }
    }
    if (table === 'meta_channels') {
      return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { phone_number_id: 'pn-1', access_token: 'tok' }, error: null }) }) }),
      }
    }
    if (table === 'message_reactions') {
      return { upsert: () => Promise.resolve({ error: null }), delete: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }) }
    }
    throw new Error(`unexpected table: ${table}`)
  },
}

import { POST } from './route'

function req(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Request
}

describe('POST /api/whatsapp/react', () => {
  it('sends via meta-api using the conversation channel, not a blind account lookup', async () => {
    resolvedProvider = 'meta'
    const res = (await POST(req({ message_id: 'msg-1', emoji: '👍' }))) as unknown as { body?: { success: boolean } }
    expect(sendReactionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: 'pn-1', accessToken: 'tok' })
    )
    expect(res.body).toEqual({ success: true })
  })

  it('returns 400 when the conversation is on a non-Meta channel', async () => {
    resolvedProvider = 'uazapi'
    const res = (await POST(req({ message_id: 'msg-1', emoji: '👍' }))) as unknown as { init?: { status: number } }
    expect(res.init?.status).toBe(400)
  })
})
