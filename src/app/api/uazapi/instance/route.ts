import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { initUazapiInstance, connectUazapiInstance } from '@/lib/whatsapp/uazapi-api'

/**
 * POST /api/uazapi/instance
 *
 * Body: { label: string, base_url: string }
 *
 * Creates a new UAZAPI-backed channel: a `channels` row, an
 * `initUazapiInstance` call to provision it server-side, a
 * `uazapi_channels` row storing the encrypted instance token + a
 * generated webhook secret, then an initial `connectUazapiInstance`
 * call to get the first QR code. If the UAZAPI init call itself fails,
 * the just-inserted `channels` row is rolled back so a failed attempt
 * doesn't leave an orphaned row behind.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const body = await request.json()
    const { label, base_url } = body as { label?: string; base_url?: string }

    if (!label || !label.trim()) {
      return NextResponse.json({ error: 'label is required' }, { status: 400 })
    }
    if (!base_url || !base_url.trim()) {
      return NextResponse.json({ error: 'base_url is required' }, { status: 400 })
    }
    const baseUrl = base_url.trim().replace(/\/+$/, '')

    const { data: existingChannels } = await supabase
      .from('channels')
      .select('id')
      .eq('account_id', accountId)
    const isDefault = (existingChannels ?? []).length === 0

    const { data: channel, error: channelError } = await supabase
      .from('channels')
      .insert({
        account_id: accountId,
        provider: 'uazapi',
        label: label.trim(),
        status: 'connecting',
        is_default: isDefault,
        created_by: userId,
      })
      .select('id')
      .single()

    if (channelError || !channel) {
      return NextResponse.json({ error: 'Failed to create channel' }, { status: 500 })
    }

    let instance
    try {
      instance = await initUazapiInstance({ baseUrl, name: label.trim() })
    } catch (err) {
      await supabase.from('channels').delete().eq('id', channel.id)
      const message = err instanceof Error ? err.message : 'Unknown UAZAPI error'
      return NextResponse.json({ error: `Failed to create UAZAPI instance: ${message}` }, { status: 502 })
    }

    const webhookSecret = crypto.randomBytes(24).toString('hex')

    let qrCode: string | null = null
    try {
      const connectResult = await connectUazapiInstance({ baseUrl, instanceToken: instance.token })
      qrCode = connectResult.qrCode ?? null
    } catch (err) {
      console.warn('[uazapi/instance POST] initial connect failed (channel still created):', err)
    }

    const { error: uazapiError } = await supabase.from('uazapi_channels').insert({
      channel_id: channel.id,
      instance_id: instance.id,
      instance_token: encrypt(instance.token),
      base_url: baseUrl,
      qr_code: qrCode,
      webhook_secret: encrypt(webhookSecret),
    })

    if (uazapiError) {
      await supabase.from('channels').delete().eq('id', channel.id)
      return NextResponse.json({ error: 'Failed to save UAZAPI instance' }, { status: 500 })
    }

    return NextResponse.json({ channelId: channel.id, qrCode })
  } catch (error) {
    return toErrorResponse(error)
  }
}
