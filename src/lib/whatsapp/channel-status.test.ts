import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { setChannelStatus } from './channel-status'

function makeDb(updateError: { message: string } | null) {
  const calls: { table: string; patch: Record<string, unknown>; id: string }[] = []
  return {
    db: {
      from: (table: string) => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            calls.push({ table, patch, id })
            return Promise.resolve({ error: updateError })
          },
        }),
      }),
    } as unknown as SupabaseClient,
    calls,
  }
}

describe('setChannelStatus', () => {
  it('updates channels.status and updated_at for the given id', async () => {
    const { db, calls } = makeDb(null)
    await setChannelStatus(db, 'ch-1', 'connected')
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('channels')
    expect(calls[0].id).toBe('ch-1')
    expect(calls[0].patch).toMatchObject({ status: 'connected' })
    expect(typeof calls[0].patch.updated_at).toBe('string')
  })

  it('logs a warning but does not throw when the update fails', async () => {
    const { db } = makeDb({ message: 'boom' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(setChannelStatus(db, 'ch-1', 'error')).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
