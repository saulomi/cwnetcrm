import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { disconnectUazapiInstance } from '@/lib/whatsapp/uazapi-api'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * Deleting the account's default channel leaves zero channels marked
 * default. Once an account has 2+ channels, the next send falls
 * through to resolveChannelForSend's "exactly one connected channel"
 * fallback, which throws `ambiguous` (2+ connected) or
 * `not_configured` (0 connected) instead of just picking one — so a
 * replacement default must be promoted right away.
 *
 * Preference order: a connected channel first, else the oldest
 * remaining channel (created_at ascending) as the tiebreak. Does
 * nothing if no channels remain on the account.
 *
 * Fire-and-log, not fire-and-throw — the channel being removed is
 * already gone from the database by the time this runs, so a failure
 * here shouldn't fail the whole delete (same posture as
 * setChannelStatus in channel-status.ts).
 */
async function promoteNewDefaultChannel(supabase: SupabaseClient, accountId: string): Promise<void> {
  try {
    const { data: candidates, error } = await supabase
      .from('channels')
      .select('id, status, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })

    if (error) {
      console.warn('[channels DELETE] failed to look up channels for default promotion:', error.message)
      return
    }
    if (!candidates || candidates.length === 0) return

    const winner =
      candidates.find((c: { status: string }) => c.status === 'connected') ?? candidates[0]

    const { error: updateError } = await supabase
      .from('channels')
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq('id', winner.id)

    if (updateError) {
      console.warn('[channels DELETE] failed to promote new default channel:', updateError.message)
    }
  } catch (err) {
    console.warn('[channels DELETE] failed to promote new default channel:', err)
  }
}

/**
 * PATCH /api/channels/[id]
 *
 * Body: { label?: string, is_default?: boolean }
 *
 * Setting is_default=true first clears any existing default on the
 * account — channels has a unique partial index enforcing at most one
 * `is_default=true` row per account (migration 039), so setting a new
 * default without clearing the old one first would violate it.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const body = await request.json()
    const { label, is_default } = body as { label?: string; is_default?: boolean }

    if (label === undefined && is_default === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    if (is_default === true) {
      const { error: clearError } = await supabase
        .from('channels')
        .update({ is_default: false })
        .eq('account_id', accountId)
      if (clearError) {
        return NextResponse.json({ error: 'Failed to clear existing default channel' }, { status: 500 })
      }
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (label !== undefined) patch.label = label
    if (is_default !== undefined) patch.is_default = is_default

    const { error } = await supabase.from('channels').update(patch).eq('id', id)
    if (error) {
      return NextResponse.json({ error: 'Failed to update channel' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * DELETE /api/channels/[id]
 *
 * Meta channels are removed via their `meta_channels` row — the
 * existing AFTER DELETE trigger (migration 039) cleans up the parent
 * `channels` row. UAZAPI channels have no such trigger in that
 * direction, so the `channels` row is deleted directly; its
 * `uazapi_channels` row cascades via ON DELETE CASCADE. Deleting a
 * `channels` row directly for a Meta channel would instead hit the
 * cleanup trigger from the wrong side — always route by provider.
 */
export async function DELETE(_request: Request, { params }: RouteContext) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params

    const { data: channel, error: findError } = await supabase
      .from('channels')
      .select('id, account_id, provider, is_default')
      .eq('id', id)
      .single()

    if (findError || !channel || channel.account_id !== accountId) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    if (channel.provider === 'meta') {
      const { error } = await supabase.from('meta_channels').delete().eq('channel_id', id)
      if (error) {
        return NextResponse.json({ error: 'Failed to remove channel' }, { status: 500 })
      }
      if (channel.is_default) {
        await promoteNewDefaultChannel(supabase, accountId)
      }
      return NextResponse.json({ success: true })
    }

    // UAZAPI — best-effort disconnect on the provider's side first. A
    // failure here (server unreachable, instance already gone) must not
    // block removing our own record of it.
    const { data: uazapiChannel } = await supabase
      .from('uazapi_channels')
      .select('base_url, instance_token')
      .eq('channel_id', id)
      .single()
    if (uazapiChannel) {
      try {
        await disconnectUazapiInstance({
          baseUrl: uazapiChannel.base_url,
          instanceToken: decrypt(uazapiChannel.instance_token),
        })
      } catch (err) {
        console.warn('[channels DELETE] UAZAPI disconnect failed (continuing):', err)
      }
    }

    const { error } = await supabase.from('channels').delete().eq('id', id)
    if (error) {
      return NextResponse.json({ error: 'Failed to remove channel' }, { status: 500 })
    }
    if (channel.is_default) {
      await promoteNewDefaultChannel(supabase, accountId)
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
