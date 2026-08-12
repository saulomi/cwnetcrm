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
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v.replace(/^enc:/, '') }))
vi.mock('@/lib/whatsapp/channel-status', () => ({ setChannelStatus: vi.fn(async () => {}) }))

let statusResult: { status: string; phone?: string; profileName?: string } = { status: 'connecting' }
let connectResult: { status: string; qrCode?: string } = { status: 'connecting', qrCode: 'fresh-qr' }
const updateCalls: Record<string, unknown>[] = []

vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  fetchUazapiInstanceStatus: vi.fn(async () => statusResult),
  connectUazapiInstance: vi.fn(async () => connectResult),
}))

const db = {
  from: (table: string) => {
    if (table === 'uazapi_channels') {
      return {
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: { channel_id: 'ch-1', base_url: 'https://x', instance_token: 'enc:tok', status_cache: 'connecting' },
                error: null,
              }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          updateCalls.push(patch)
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    }
    throw new Error(`unexpected table: ${table}`)
  },
}

import { GET } from './route'
const ctx = { params: Promise.resolve({ channelId: 'ch-1' }) }

describe('GET /api/uazapi/instance/[channelId]', () => {
  it('returns connected + phone once UAZAPI reports connected, and updates the row', async () => {
    updateCalls.length = 0
    statusResult = { status: 'connected', phone: '5511999998888', profileName: 'Ada' }
    const res = (await GET(new Request('http://x'), ctx)) as unknown as {
      body: { status: string; phone?: string; profileName?: string }
    }
    expect(res.body).toEqual({ status: 'connected', phone: '5511999998888', profileName: 'Ada' })
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ connected_phone: '5511999998888', profile_name: 'Ada', qr_code: null })
    )
  })

  it('refreshes the QR while still connecting', async () => {
    statusResult = { status: 'connecting' }
    connectResult = { status: 'connecting', qrCode: 'refreshed-qr' }
    const res = (await GET(new Request('http://x'), ctx)) as unknown as { body: { status: string; qrCode?: string } }
    expect(res.body).toEqual({ status: 'connecting', qrCode: 'refreshed-qr' })
  })
})
