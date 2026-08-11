import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveChannelForSend, resolveProvider } from './channel-resolution'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace(/^(enc|legacy):/, ''),
  encrypt: (v: string) => `enc:${v}`,
  isLegacyFormat: (v: string) => v.startsWith('legacy:'),
}))

const createMetaProvider = vi.fn(() => ({ sendText: vi.fn() }))
vi.mock('./meta-provider', () => ({
  createMetaProvider: (...args: unknown[]) =>
    (createMetaProvider as unknown as (...a: unknown[]) => unknown)(...args),
}))

// ------------------------------------------------------------
// resolveChannelForSend
// ------------------------------------------------------------

interface ChannelFixture {
  byId?: Record<string, { id: string; provider: 'meta' | 'uazapi' } | null>
  default?: { id: string; provider: 'meta' | 'uazapi' } | null
  connected?: { id: string; provider: 'meta' | 'uazapi' }[]
}

function channelsDb(fx: ChannelFixture): SupabaseClient {
  return {
    from(table: string) {
      if (table !== 'channels') throw new Error(`unexpected table: ${table}`)
      let idFilter: string | undefined
      let defaultFilter = false
      let statusFilter: string | undefined
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'id') idFilter = val as string
          if (col === 'is_default' && val === true) defaultFilter = true
          if (col === 'status') statusFilter = val as string
          return b
        },
        maybeSingle: async () => {
          if (idFilter !== undefined) {
            return { data: fx.byId?.[idFilter] ?? null, error: null }
          }
          if (defaultFilter) {
            return { data: fx.default ?? null, error: null }
          }
          return { data: null, error: null }
        },
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
          if (statusFilter === 'connected') {
            return resolve({ data: fx.connected ?? [], error: null })
          }
          return resolve({ data: [], error: null })
        },
      }
      return b
    },
  } as unknown as SupabaseClient
}

describe('resolveChannelForSend', () => {
  it('uses the conversation channel when it belongs to this account', async () => {
    const db = channelsDb({ byId: { 'ch-1': { id: 'ch-1', provider: 'meta' } } })
    const result = await resolveChannelForSend(db, 'acct-1', 'ch-1')
    expect(result).toEqual({ channelId: 'ch-1', provider: 'meta' })
  })

  it('falls back to the account default when no conversation channel is set', async () => {
    const db = channelsDb({ default: { id: 'ch-default', provider: 'meta' } })
    const result = await resolveChannelForSend(db, 'acct-1', null)
    expect(result).toEqual({ channelId: 'ch-default', provider: 'meta' })
  })

  it('falls back to the account default when the conversation channel is not found', async () => {
    const db = channelsDb({
      byId: { 'ch-gone': null },
      default: { id: 'ch-default', provider: 'meta' },
    })
    const result = await resolveChannelForSend(db, 'acct-1', 'ch-gone')
    expect(result).toEqual({ channelId: 'ch-default', provider: 'meta' })
  })

  it('falls back to the single connected channel when there is no default', async () => {
    const db = channelsDb({ connected: [{ id: 'ch-only', provider: 'meta' }] })
    const result = await resolveChannelForSend(db, 'acct-1', null)
    expect(result).toEqual({ channelId: 'ch-only', provider: 'meta' })
  })

  it('throws not_configured when nothing is connected', async () => {
    const db = channelsDb({})
    await expect(resolveChannelForSend(db, 'acct-1', null)).rejects.toMatchObject({
      code: 'not_configured',
    })
  })

  it('throws ambiguous when several channels are connected and none is default', async () => {
    const db = channelsDb({
      connected: [
        { id: 'ch-a', provider: 'meta' },
        { id: 'ch-b', provider: 'uazapi' },
      ],
    })
    await expect(resolveChannelForSend(db, 'acct-1', null)).rejects.toMatchObject({
      code: 'ambiguous',
    })
  })
})

// ------------------------------------------------------------
// resolveProvider
// ------------------------------------------------------------

interface MetaChannelFixture {
  metaChannel?: Record<string, unknown> | null
}

function metaChannelDb(
  fx: MetaChannelFixture,
  captured: { update?: Record<string, unknown> }
): SupabaseClient {
  return {
    from(table: string) {
      if (table !== 'meta_channels') throw new Error(`unexpected table: ${table}`)
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        single: async () => ({
          data: fx.metaChannel === undefined ? null : fx.metaChannel,
          error: fx.metaChannel === undefined ? { message: 'not found' } : null,
        }),
        update: (row: Record<string, unknown>) => {
          captured.update = row
          return b
        },
        then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }),
      }
      return b
    },
  } as unknown as SupabaseClient
}

describe('resolveProvider', () => {
  it('throws not_implemented for a uazapi channel', async () => {
    await expect(
      resolveProvider({} as SupabaseClient, { channelId: 'ch-1', provider: 'uazapi' })
    ).rejects.toMatchObject({ code: 'not_implemented' })
  })

  it('throws not_configured when the meta_channels row is missing', async () => {
    const db = metaChannelDb({}, {})
    await expect(
      resolveProvider(db, { channelId: 'ch-1', provider: 'meta' })
    ).rejects.toMatchObject({ code: 'not_configured' })
  })

  it('builds a MetaProvider from the decrypted credentials', async () => {
    createMetaProvider.mockClear()
    const db = metaChannelDb(
      { metaChannel: { id: 'mc-1', phone_number_id: 'pn-1', access_token: 'enc:tok-1' } },
      {}
    )
    await resolveProvider(db, { channelId: 'ch-1', provider: 'meta' })
    expect(createMetaProvider).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
    })
  })

  it('self-heals a legacy-ciphertext token without blocking the send', async () => {
    const captured: { update?: Record<string, unknown> } = {}
    const db = metaChannelDb(
      { metaChannel: { id: 'mc-1', phone_number_id: 'pn-1', access_token: 'legacy:tok-1' } },
      captured
    )
    await resolveProvider(db, { channelId: 'ch-1', provider: 'meta' })
    // Fire-and-forget — give the microtask queue a tick to run it.
    await new Promise((r) => setTimeout(r, 0))
    expect(captured.update?.access_token).toBe('enc:tok-1')
  })
})
