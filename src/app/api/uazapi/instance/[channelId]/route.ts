import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { fetchUazapiInstanceStatus, connectUazapiInstance } from '@/lib/whatsapp/uazapi-api'
import { setChannelStatus } from '@/lib/whatsapp/channel-status'

interface RouteContext {
  params: Promise<{ channelId: string }>
}

/**
 * GET /api/uazapi/instance/[channelId]
 *
 * Polled by the Settings UI while a UAZAPI channel is connecting.
 * Connected: updates connected_phone/profile_name, clears the cached
 * QR, mirrors channels.status to 'connected'. Still connecting: calls
 * connect again to get a fresh QR (UAZAPI QR codes expire) rather than
 * serving the possibly-stale cached one. Error: mirrors channels.status
 * to 'error' and returns the failure message.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { supabase } = await requireRole('agent')
    const { channelId } = await params

    const { data: uazapiChannel, error } = await supabase
      .from('uazapi_channels')
      .select('*')
      .eq('channel_id', channelId)
      .single()

    if (error || !uazapiChannel) {
      return NextResponse.json({ error: 'UAZAPI channel not found' }, { status: 404 })
    }

    const instanceToken = decrypt(uazapiChannel.instance_token)

    let status
    try {
      status = await fetchUazapiInstanceStatus({ baseUrl: uazapiChannel.base_url, instanceToken })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
      await setChannelStatus(supabase, channelId, 'error')
      await supabase.from('uazapi_channels').update({ last_error: message }).eq('channel_id', channelId)
      return NextResponse.json({ status: 'error', message })
    }

    if (status.status === 'connected') {
      await supabase
        .from('uazapi_channels')
        .update({ connected_phone: status.phone ?? null, profile_name: status.profileName ?? null, qr_code: null })
        .eq('channel_id', channelId)
      await setChannelStatus(supabase, channelId, 'connected')
      return NextResponse.json({ status: 'connected', phone: status.phone, profileName: status.profileName })
    }

    if (status.status === 'error') {
      await setChannelStatus(supabase, channelId, 'error')
      return NextResponse.json({ status: 'error' })
    }

    // Still connecting (or disconnected-but-retrying) — refresh the QR,
    // since UAZAPI QR codes expire on a short timer.
    try {
      const connectResult = await connectUazapiInstance({ baseUrl: uazapiChannel.base_url, instanceToken })
      if (connectResult.qrCode) {
        await supabase.from('uazapi_channels').update({ qr_code: connectResult.qrCode }).eq('channel_id', channelId)
      }
      return NextResponse.json({ status: 'connecting', qrCode: connectResult.qrCode })
    } catch (err) {
      console.warn('[uazapi/instance GET] QR refresh failed:', err)
      return NextResponse.json({ status: 'connecting', qrCode: uazapiChannel.qr_code ?? undefined })
    }
  } catch (error) {
    return toErrorResponse(error)
  }
}
