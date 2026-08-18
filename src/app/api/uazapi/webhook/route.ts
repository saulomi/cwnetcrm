// ============================================================
// Inbound UAZAPI webhook.
//
// PAYLOAD SHAPE IS A BEST-EFFORT ASSUMPTION, NOT VERIFIED AGAINST A
// LIVE INSTANCE — see docs/superpowers/plans/2026-08-12-uazapi-
// provider-plan-4-provider-ui.md, Task 9, for the exact shape and why.
// Everything past `normalize*` below only sees NormalizedInboundMessage
// / handleStatusUpdate's status object, both provider-agnostic — a
// future payload correction is isolated to this file.
// ============================================================

import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import {
  processInboundMessage,
  handleStatusUpdate,
  type NormalizedInboundMessage,
} from '@/lib/whatsapp/inbound-processor'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface UazapiMessage {
  id: string
  from: string
  fromName?: string
  type: 'text' | 'image' | 'video' | 'document' | 'audio' | 'button' | 'list' | 'reaction'
  text?: string
  mediaUrl?: string
  caption?: string
  buttonId?: string
  listId?: string
  quotedMessageId?: string
  reaction?: { emoji: string; targetMessageId: string }
  timestamp?: number
}

interface UazapiStatusEvent {
  messageId: string
  status: string
  recipientId?: string
  timestamp?: number
}

interface UazapiWebhookBody {
  instance_id: string
  event: 'message' | 'status'
  message?: UazapiMessage
  status?: UazapiStatusEvent
}

function normalizeType(raw: UazapiMessage['type']): NormalizedInboundMessage['type'] {
  switch (raw) {
    case 'button':
    case 'list':
      return 'interactive'
    case 'reaction':
      return 'reaction'
    case 'image':
    case 'video':
    case 'document':
    case 'audio':
      return raw
    default:
      return 'text'
  }
}

export async function POST(request: Request) {
  const raw = await request.text()
  let body: UazapiWebhookBody
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.instance_id) {
    return NextResponse.json({ error: 'Missing instance_id' }, { status: 400 })
  }

  const db = supabaseAdmin()

  const { data: uazapiChannel, error: lookupError } = await db
    .from('uazapi_channels')
    .select('channel_id, webhook_secret, channels(id, account_id, created_by)')
    .eq('instance_id', body.instance_id)
    .maybeSingle()

  if (lookupError || !uazapiChannel) {
    return NextResponse.json({ error: 'Unknown instance' }, { status: 404 })
  }

  const providedSecret = request.headers.get('x-uazapi-secret')
  const expectedSecret = uazapiChannel.webhook_secret ? decrypt(uazapiChannel.webhook_secret) : null
  if (!expectedSecret || !providedSecret) {
    return NextResponse.json({ error: 'Invalid webhook secret' }, { status: 401 })
  }
  const a = Buffer.from(providedSecret)
  const b = Buffer.from(expectedSecret)
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Invalid webhook secret' }, { status: 401 })
  }

  // Supabase's embedded-join typing for a to-one reverse FK is
  // inconsistent between object and single-element-array — same
  // ambiguity Plan 3's inbound-processor.ts hit, guarded the same way.
  const channelRow = Array.isArray(uazapiChannel.channels) ? uazapiChannel.channels[0] : uazapiChannel.channels
  const channelId: string = channelRow?.id ?? uazapiChannel.channel_id
  const accountId: string = channelRow?.account_id
  if (!accountId) {
    return NextResponse.json({ error: 'Channel has no account' }, { status: 500 })
  }

  const configOwnerUserId: string = channelRow?.created_by ?? (await resolveAuditUserId(db, accountId))

  if (body.event === 'status' && body.status) {
    await handleStatusUpdate(db, {
      id: body.status.messageId,
      status: body.status.status,
      timestamp: String(body.status.timestamp ?? Math.floor(Date.now() / 1000)),
      recipient_id: body.status.recipientId ?? '',
    })
    return NextResponse.json({ success: true })
  }

  const m = body.message
  if (!m) {
    return NextResponse.json({ success: true })
  }

  const base = {
    channelId,
    accountId,
    configOwnerUserId,
    from: m.from,
    contactName: m.fromName || m.from,
    waMessageId: m.id,
    timestamp: String(m.timestamp ?? Math.floor(Date.now() / 1000)),
    providerType: m.type,
  }

  if (m.type === 'reaction' && m.reaction) {
    await processInboundMessage(db, {
      ...base,
      type: 'reaction',
      reactionEmoji: m.reaction.emoji,
      replyToWaMessageId: m.reaction.targetMessageId,
    })
    return NextResponse.json({ success: true })
  }

  await processInboundMessage(db, {
    ...base,
    type: normalizeType(m.type),
    text: m.text ?? m.caption,
    mediaUrl: m.mediaUrl,
    interactiveReplyId: m.buttonId ?? m.listId,
    replyToWaMessageId: m.quotedMessageId,
  })

  return NextResponse.json({ success: true })
}
