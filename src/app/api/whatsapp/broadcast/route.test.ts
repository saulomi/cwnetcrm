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
  RATE_LIMITS: { broadcast: {} },
}))
vi.mock('@/lib/whatsapp/phone-utils', () => ({
  sanitizePhoneForMeta: (p: string) => p,
  isValidE164: () => true,
  phoneVariants: (p: string) => [p],
  isRecipientNotAllowedError: () => false,
}))
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: vi.fn(async () => ({ row: { name: 'promo', body_text: 'hi' }, malformed: false, language: 'en_US' })),
}))

const sendTemplate = vi.fn(async () => ({ messageId: 'sent-1' }))
vi.mock('@/lib/whatsapp/channel-resolution', () => ({
  resolveChannelForSend: vi.fn(async () => ({ channelId: 'ch-1', provider: 'meta' })),
  resolveProvider: vi.fn(async () => ({ sendTemplate })),
  ChannelResolutionError: class extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))

const db = {}

import { POST } from './route'

function req(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Request
}

describe('POST /api/whatsapp/broadcast', () => {
  it('sends via the resolved provider instead of calling meta-api directly', async () => {
    const res = (await POST(
      req({ recipients: [{ phone: '+15551230000', params: [] }], template_name: 'promo' })
    )) as unknown as { body: { sent: number; failed: number } }
    expect(sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+15551230000', templateName: 'promo' })
    )
    expect(res.body).toMatchObject({ sent: 1, failed: 0 })
  })
})
