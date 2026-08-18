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

const db = {
  from: (table: string) => {
    if (table === 'channels') {
      return {
        select: () => ({
          eq: () => ({
            order: () =>
              Promise.resolve({
                data: [
                  { id: 'ch-1', provider: 'meta', label: 'WhatsApp', status: 'connected', is_default: true },
                  { id: 'ch-2', provider: 'uazapi', label: 'Sales', status: 'connecting', is_default: false },
                ],
                error: null,
              }),
          }),
        }),
      }
    }
    if (table === 'meta_channels') {
      return {
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: [
                { channel_id: 'ch-1', phone_number_id: 'pn-1', waba_id: 'waba-1', registered_at: '2026-01-01', last_registration_error: null },
              ],
              error: null,
            }),
        }),
      }
    }
    if (table === 'uazapi_channels') {
      return {
        select: () => ({
          in: () =>
            Promise.resolve({
              data: [
                { channel_id: 'ch-2', instance_id: 'inst-1', base_url: 'https://x', connected_phone: null, profile_name: null, last_error: null },
              ],
              error: null,
            }),
        }),
      }
    }
    throw new Error(`unexpected table: ${table}`)
  },
}

import { GET } from './route'

describe('GET /api/channels', () => {
  it('merges channels with their provider-specific detail', async () => {
    const res = (await GET()) as unknown as { body: { channels: Array<Record<string, unknown>> } }
    expect(res.body.channels).toHaveLength(2)
    expect(res.body.channels[0]).toMatchObject({
      id: 'ch-1',
      provider: 'meta',
      meta: { phone_number_id: 'pn-1' },
    })
    expect(res.body.channels[1]).toMatchObject({
      id: 'ch-2',
      provider: 'uazapi',
      uazapi: { instance_id: 'inst-1' },
    })
  })
})
