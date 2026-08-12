import { describe, it, expect, vi } from 'vitest'

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: db, accountId: 'acc-1', userId: 'user-1', role: 'admin', account: { id: 'acc-1', name: 'Acc' } })),
  toErrorResponse: (err: unknown) => ({ body: { error: String(err) }, init: { status: 500 } }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (v: string) => `enc:${v}` }))
vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  initUazapiInstance: vi.fn(async () => ({ id: 'inst-1', token: 'raw-token' })),
  connectUazapiInstance: vi.fn(async () => ({ status: 'connecting', qrCode: 'base64qr' })),
}))

const inserted: { table: string; row: Record<string, unknown> }[] = []

const db = {
  from: (table: string) => {
    if (table === 'channels') {
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }), // zero existing channels
        insert: (row: Record<string, unknown>) => {
          inserted.push({ table, row })
          return { select: () => ({ single: () => Promise.resolve({ data: { id: 'ch-new' }, error: null }) }) }
        },
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }
    }
    if (table === 'uazapi_channels') {
      return {
        insert: (row: Record<string, unknown>) => {
          inserted.push({ table, row })
          return Promise.resolve({ error: null })
        },
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }
    }
    throw new Error(`unexpected table: ${table}`)
  },
}

import { POST } from './route'

function req(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Request
}

describe('POST /api/uazapi/instance', () => {
  it('creates channels + uazapi_channels rows and returns the first QR', async () => {
    inserted.length = 0
    const res = (await POST(req({ label: 'Sales', base_url: 'https://demo.uazapi.example' }))) as unknown as {
      body: { channelId: string; qrCode: string | null }
    }
    expect(res.body).toEqual({ channelId: 'ch-new', qrCode: 'base64qr' })

    const channelInsert = inserted.find((i) => i.table === 'channels')!
    expect(channelInsert.row).toMatchObject({
      account_id: 'acc-1',
      provider: 'uazapi',
      label: 'Sales',
      status: 'connecting',
      is_default: true, // zero prior channels
    })

    const uazapiInsert = inserted.find((i) => i.table === 'uazapi_channels')!
    expect(uazapiInsert.row).toMatchObject({
      channel_id: 'ch-new',
      instance_id: 'inst-1',
      instance_token: 'enc:raw-token',
      base_url: 'https://demo.uazapi.example',
      qr_code: 'base64qr',
    })
  })

  it('rejects a missing base_url', async () => {
    const res = (await POST(req({ label: 'Sales' }))) as unknown as { init: { status: number } }
    expect(res.init.status).toBe(400)
  })
})
