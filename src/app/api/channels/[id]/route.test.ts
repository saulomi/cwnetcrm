import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: { patch: [] as unknown[], deletedTables: [] as string[], updateIds: [] as string[] },
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
let channelIsDefault = false
// Remaining channels on the account after the deleted one is gone —
// used to answer the promotion-candidates query.
let remainingChannels: Array<{ id: string; status: string; created_at: string }> = []

const db = {
  from: (table: string) => {
    if (table === 'channels') {
      return {
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: { id: 'ch-1', account_id: 'acc-1', provider: channelProvider, is_default: channelIsDefault },
                error: null,
              }),
            order: () => Promise.resolve({ data: remainingChannels, error: null }),
          }),
        }),
        update: (patch: unknown) => {
          h.calls.patch.push(patch)
          return {
            eq: (_col: string, val: string) => {
              h.calls.updateIds.push(val)
              return Promise.resolve({ error: null })
            },
          }
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
    channelIsDefault = false
    h.calls.deletedTables = []
    await DELETE(req({}), ctx)
    expect(h.calls.deletedTables).toEqual(['meta_channels'])
  })

  it('deletes the channels row directly for a UAZAPI channel', async () => {
    channelProvider = 'uazapi'
    channelIsDefault = false
    h.calls.deletedTables = []
    await DELETE(req({}), ctx)
    expect(h.calls.deletedTables).toEqual(['channels'])
  })

  it('deleting a non-default channel does not attempt any default reassignment', async () => {
    channelProvider = 'uazapi'
    channelIsDefault = false
    remainingChannels = [{ id: 'ch-2', status: 'connected', created_at: '2026-01-01T00:00:00Z' }]
    h.calls.patch = []
    h.calls.updateIds = []
    await DELETE(req({}), ctx)
    expect(h.calls.patch).toEqual([])
    expect(h.calls.updateIds).toEqual([])
  })

  it('promotes the connected channel over an unconnected-but-older one when deleting the default', async () => {
    channelProvider = 'uazapi'
    channelIsDefault = true
    remainingChannels = [
      { id: 'ch-older', status: 'disconnected', created_at: '2026-01-01T00:00:00Z' },
      { id: 'ch-connected', status: 'connected', created_at: '2026-02-01T00:00:00Z' },
    ]
    h.calls.patch = []
    h.calls.updateIds = []
    const res = await DELETE(req({}), ctx)
    expect(h.calls.patch).toContainEqual({ is_default: true, updated_at: expect.any(String) })
    expect(h.calls.updateIds).toContain('ch-connected')
    expect(await (res as Response).json()).toEqual({ success: true })
  })

  it('falls back to the oldest remaining channel when none are connected', async () => {
    channelProvider = 'meta'
    channelIsDefault = true
    // Mock stands in for the real query, which already returns rows
    // sorted ascending by created_at — oldest first.
    remainingChannels = [
      { id: 'ch-oldest', status: 'error', created_at: '2026-01-01T00:00:00Z' },
      { id: 'ch-newer', status: 'disconnected', created_at: '2026-02-01T00:00:00Z' },
    ]
    h.calls.patch = []
    h.calls.updateIds = []
    await DELETE(req({}), ctx)
    expect(h.calls.updateIds).toContain('ch-oldest')
  })

  it('does nothing when deleting the default channel leaves no channels behind', async () => {
    channelProvider = 'uazapi'
    channelIsDefault = true
    remainingChannels = []
    h.calls.patch = []
    h.calls.updateIds = []
    const res = await DELETE(req({}), ctx)
    expect(h.calls.patch).toEqual([])
    expect(h.calls.updateIds).toEqual([])
    expect(await (res as Response).json()).toEqual({ success: true })
  })
})
