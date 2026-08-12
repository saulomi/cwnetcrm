import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: { patch: [] as unknown[], deletedTables: [] as string[] },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: db, accountId: 'acc-1', userId: 'user-1', role: 'admin', account: { id: 'acc-1', name: 'Acc' } })),
  toErrorResponse: (err: unknown) => ({ body: { error: String(err) }, init: { status: 500 } }),
}))
vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  disconnectUazapiInstance: vi.fn(async () => {}),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))

let channelProvider = 'meta'

const db = {
  from: (table: string) => {
    if (table === 'channels') {
      return {
        select: () => ({
          eq: () => ({ single: () => Promise.resolve({ data: { id: 'ch-1', account_id: 'acc-1', provider: channelProvider }, error: null }) }),
        }),
        update: (patch: unknown) => {
          h.calls.patch.push(patch)
          return { eq: () => Promise.resolve({ error: null }) }
        },
        delete: () => {
          h.calls.deletedTables.push('channels')
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    }
    if (table === 'meta_channels') {
      return { delete: () => { h.calls.deletedTables.push('meta_channels'); return { eq: () => Promise.resolve({ error: null }) } } }
    }
    if (table === 'uazapi_channels') {
      return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { base_url: 'https://x', instance_token: 'tok' }, error: null }) }) }),
      }
    }
    throw new Error(`unexpected table: ${table}`)
  },
}

import { PATCH, DELETE } from './route'

function req(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Request
}
const ctx = { params: Promise.resolve({ id: 'ch-1' }) }

describe('PATCH /api/channels/[id]', () => {
  it('clears the account default before setting a new one', async () => {
    channelProvider = 'meta'
    h.calls.patch = []
    await PATCH(req({ is_default: true }), ctx)
    expect(h.calls.patch).toEqual([
      { is_default: false },
      { is_default: true, updated_at: expect.any(String) },
    ])
  })

  it('updates the label', async () => {
    h.calls.patch = []
    await PATCH(req({ label: 'Support' }), ctx)
    expect(h.calls.patch).toContainEqual({ label: 'Support', updated_at: expect.any(String) })
  })
})

describe('DELETE /api/channels/[id]', () => {
  it('deletes via meta_channels for a Meta channel', async () => {
    channelProvider = 'meta'
    h.calls.deletedTables = []
    await DELETE(req({}), ctx)
    expect(h.calls.deletedTables).toEqual(['meta_channels'])
  })

  it('deletes the channels row directly for a UAZAPI channel', async () => {
    channelProvider = 'uazapi'
    h.calls.deletedTables = []
    await DELETE(req({}), ctx)
    expect(h.calls.deletedTables).toEqual(['channels'])
  })
})
