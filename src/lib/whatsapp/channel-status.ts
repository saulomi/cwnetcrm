import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Keep `channels.status` (the cross-provider registry, Plan 1) in sync
 * whenever a provider-specific row's connection state changes.
 *
 * Today only `meta_channels.status` gets written on save/register — this
 * fills in the parallel write so `channels.status` is never stale, which
 * matters the moment an account has more than one channel:
 * `resolveChannelForSend` (channel-resolution.ts) falls back to "the
 * single connected channel" when there's no default, and that fallback
 * filters on `channels.status = 'connected'`.
 *
 * Fire-and-log, not fire-and-throw — a failed status mirror shouldn't
 * fail the caller's actual save/connect/send operation, which already
 * succeeded on the provider side by the time this runs.
 */
export type ChannelStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

export async function setChannelStatus(
  db: SupabaseClient,
  channelId: string,
  status: ChannelStatus,
): Promise<void> {
  const { error } = await db
    .from('channels')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', channelId)

  if (error) {
    console.warn('[channel-status] failed to update channels.status:', error.message)
  }
}
