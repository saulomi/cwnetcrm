import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  state: {
    channelStatusCalls: [] as { channelId: string; status: string }[],
  },
}))

vi.mock('@/lib/whatsapp/channel-status', () => ({
  setChannelStatus: vi.fn(async (_db: unknown, channelId: string, status: string) => {
    h.state.channelStatusCalls.push({ channelId, status })
  }),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  registerPhoneNumber: vi.fn(async () => ({})),
  subscribeWabaToApp: vi.fn(async () => ({})),
  verifyPhoneNumber: vi.fn(async () => ({ verified_name: 'Ada Co' })),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      if (table === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { account_id: 'acc-1' }, error: null }) }) }) }
      }
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
          }),
          insert: () => ({ channel_id: undefined }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              neq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
            }),
          }),
          insert: () => Promise.resolve({ error: null }),
        }
      }
      if (table === 'meta_channels') {
        // Follow-up channel_id lookup after insert/update.
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: { channel_id: 'ch-1' }, error: null }) }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { POST } from './route'

function req(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Request
}

beforeEach(() => {
  h.state.channelStatusCalls = []
})

describe('POST /api/whatsapp/config', () => {
  it('mirrors the resulting status onto channels via setChannelStatus', async () => {
    await POST(
      req({ phone_number_id: 'pn-1', waba_id: 'waba-1', access_token: 'tok-1' })
    )
    expect(h.state.channelStatusCalls).toContainEqual({ channelId: 'ch-1', status: 'connected' })
  })
})
