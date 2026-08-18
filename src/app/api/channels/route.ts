import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/channels
 *
 * Lists every WhatsApp channel (any provider) connected to the caller's
 * account, merged with provider-specific detail. Three simple queries +
 * an in-memory merge rather than one embedded-join select — Supabase's
 * embedded-join typing for a reverse one-to-one FK (channels ←
 * meta_channels / uazapi_channels) is ambiguous enough to have caused a
 * real bug in Plan 3's inbound processor; sequential queries sidestep it.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent')

    const { data: channels, error: channelsError } = await supabase
      .from('channels')
      .select('id, provider, label, status, is_default')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })

    if (channelsError) {
      return NextResponse.json({ error: 'Failed to load channels' }, { status: 500 })
    }

    const rows = channels ?? []
    const channelIds = rows.map((c) => c.id)

    const { data: metaRows } = await supabase
      .from('meta_channels')
      .select('channel_id, phone_number_id, waba_id, registered_at, last_registration_error')
      .eq('account_id', accountId)
    const metaByChannel = new Map((metaRows ?? []).map((r) => [r.channel_id, r]))

    const { data: uazapiRows } =
      channelIds.length > 0
        ? await supabase
            .from('uazapi_channels')
            .select('channel_id, instance_id, base_url, connected_phone, profile_name, last_error')
            .in('channel_id', channelIds)
        : { data: [] as never[] }
    const uazapiByChannel = new Map((uazapiRows ?? []).map((r) => [r.channel_id, r]))

    const merged = rows.map((c) => {
      if (c.provider === 'meta') {
        const meta = metaByChannel.get(c.id)
        return {
          ...c,
          meta: meta
            ? {
                phone_number_id: meta.phone_number_id,
                waba_id: meta.waba_id,
                registered_at: meta.registered_at,
                last_registration_error: meta.last_registration_error,
              }
            : undefined,
        }
      }
      const uazapi = uazapiByChannel.get(c.id)
      return {
        ...c,
        uazapi: uazapi
          ? {
              instance_id: uazapi.instance_id,
              base_url: uazapi.base_url,
              connected_phone: uazapi.connected_phone,
              profile_name: uazapi.profile_name,
              last_error: uazapi.last_error,
            }
          : undefined,
      }
    })

    return NextResponse.json({ channels: merged })
  } catch (error) {
    return toErrorResponse(error)
  }
}
