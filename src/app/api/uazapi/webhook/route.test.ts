import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  processInboundMessage: vi.fn(async () => ({ consumed: true })),
  handleStatusUpdate: vi.fn(async () => {}),
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@/lib/whatsapp/inbound-processor', () => ({
  processInboundMessage: h.processInboundMessage,
  handleStatusUpdate: h.handleStatusUpdate,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v.replace(/^enc:/, '') }))
vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: vi.fn(async () => 'fallback-owner'),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'uazapi_channels') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    channel_id: 'ch-1',
                    webhook_secret: 'enc:the-secret',
                    channels: { id: 'ch-1', account_id: 'acc-1', created_by: 'owner-1' },
                  },
                  error: null,
                }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { POST } from './route'

function req(body: Record<string, unknown>, secret = 'the-secret') {
  return {
    text: async () => JSON.stringify(body),
    headers: { get: (name: string) => (name === 'x-uazapi-secret' ? secret : null) },
  } as unknown as Request
}

beforeEach(() => {
  h.processInboundMessage.mockClear()
  h.handleStatusUpdate.mockClear()
})

describe('POST /api/uazapi/webhook', () => {
  it('rejects a request with a wrong or missing secret', async () => {
    const res = await POST(req({ instance_id: 'inst-1', event: 'message', message: { id: 'm1', from: '5511999998888', type: 'text', text: 'hi' } }, 'wrong'))
    expect((res as unknown as { init?: { status: number } }).init?.status).toBe(401)
    expect(h.processInboundMessage).not.toHaveBeenCalled()
  })

  it('normalizes a text message and calls processInboundMessage', async () => {
    await POST(
      req({
        instance_id: 'inst-1',
        event: 'message',
        message: { id: 'm1', from: '5511999998888', fromName: 'Ada', type: 'text', text: 'hi', timestamp: 1700000000 },
      })
    )
    expect(h.processInboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelId: 'ch-1',
        accountId: 'acc-1',
        from: '5511999998888',
        contactName: 'Ada',
        waMessageId: 'm1',
        type: 'text',
        text: 'hi',
        providerType: 'text',
      })
    )
  })

  it('normalizes a button tap to an interactive reply', async () => {
    await POST(
      req({
        instance_id: 'inst-1',
        event: 'message',
        message: { id: 'm2', from: '5511999998888', type: 'button', buttonId: 'YES', text: 'Yes please' },
      })
    )
    expect(h.processInboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'interactive', interactiveReplyId: 'YES', providerType: 'button' })
    )
  })

  it('normalizes a reaction and sets replyToWaMessageId to the reaction target', async () => {
    await POST(
      req({
        instance_id: 'inst-1',
        event: 'message',
        message: { id: 'm3', from: '5511999998888', type: 'reaction', reaction: { emoji: '👍', targetMessageId: 'm1' } },
      })
    )
    expect(h.processInboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'reaction', reactionEmoji: '👍', replyToWaMessageId: 'm1' })
    )
  })

  it('routes a status event to handleStatusUpdate', async () => {
    await POST(
      req({
        instance_id: 'inst-1',
        event: 'status',
        status: { messageId: 'm1', status: 'delivered', timestamp: 1700000000 },
      })
    )
    expect(h.handleStatusUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'm1', status: 'delivered' })
    )
  })
})
