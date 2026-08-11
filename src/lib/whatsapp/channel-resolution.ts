import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt, encrypt, isLegacyFormat } from './encryption'
import { createMetaProvider } from './meta-provider'
import type { WhatsAppProvider } from './provider'

export type ChannelResolutionErrorCode = 'not_configured' | 'ambiguous' | 'not_implemented'

/**
 * Thrown by {@link resolveChannelForSend} and {@link resolveProvider}.
 * Deliberately provider-agnostic — every existing call site (send-
 * message, broadcast-core, the Flows/Automations engines) catches this
 * and rethrows its own error type/status so callers outside this module
 * see no behaviour change from before this file existed.
 */
export class ChannelResolutionError extends Error {
  readonly code: ChannelResolutionErrorCode
  constructor(code: ChannelResolutionErrorCode, message: string) {
    super(message)
    this.name = 'ChannelResolutionError'
    this.code = code
  }
}

export interface ResolvedChannel {
  channelId: string
  provider: 'meta' | 'uazapi'
}

/**
 * Pick which channel an outbound send uses, per the routing rule in
 * docs/superpowers/specs/2026-08-10-uazapi-provider-design.md
 * ("Escolha de canal"):
 *
 *   1. `conversationChannelId`, if set and it still resolves to a real
 *      channel on this account.
 *   2. Else, the account's `is_default` channel.
 *   3. Else, if exactly one channel is connected, use it.
 *   4. Else (zero, or several with no default) — fail explicitly rather
 *      than guess.
 */
export async function resolveChannelForSend(
  db: SupabaseClient,
  accountId: string,
  conversationChannelId?: string | null
): Promise<ResolvedChannel> {
  if (conversationChannelId) {
    const { data } = await db
      .from('channels')
      .select('id, provider')
      .eq('id', conversationChannelId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (data) return { channelId: data.id, provider: data.provider }
  }

  const { data: defaultChannel } = await db
    .from('channels')
    .select('id, provider')
    .eq('account_id', accountId)
    .eq('is_default', true)
    .maybeSingle()
  if (defaultChannel) {
    return { channelId: defaultChannel.id, provider: defaultChannel.provider }
  }

  const { data: connected } = await db
    .from('channels')
    .select('id, provider')
    .eq('account_id', accountId)
    .eq('status', 'connected')

  const rows = connected ?? []
  if (rows.length === 0) {
    throw new ChannelResolutionError(
      'not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.'
    )
  }
  if (rows.length > 1) {
    throw new ChannelResolutionError(
      'ambiguous',
      'Multiple WhatsApp channels are connected and none is set as default. Set a default channel in Settings.'
    )
  }
  return { channelId: rows[0].id, provider: rows[0].provider }
}

/**
 * Load the resolved channel's credentials and build its provider.
 *
 * UAZAPI channels are schema-valid (Plan 1) but have no send-side
 * implementation until a later plan — `resolveChannelForSend` can still
 * route to one (e.g. it's the account's only connected channel), so
 * this throws a clear, typed error rather than a stack trace deep in a
 * provider that doesn't exist yet.
 */
export async function resolveProvider(
  db: SupabaseClient,
  channel: ResolvedChannel
): Promise<WhatsAppProvider> {
  if (channel.provider === 'uazapi') {
    throw new ChannelResolutionError(
      'not_implemented',
      'UAZAPI channels cannot send messages yet.'
    )
  }

  const { data: metaChannel, error } = await db
    .from('meta_channels')
    .select('*')
    .eq('channel_id', channel.channelId)
    .single()
  if (error || !metaChannel) {
    throw new ChannelResolutionError(
      'not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.'
    )
  }

  const accessToken = decrypt(metaChannel.access_token)

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  // Centralized here now, so every sender benefits — previously only
  // send-message.ts (the dashboard/public-API path) did this; the
  // Flows and Automations engines silently never upgraded a legacy row.
  if (isLegacyFormat(metaChannel.access_token)) {
    void db
      .from('meta_channels')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', metaChannel.id)
      .then(({ error: updateError }: { error: { message: string } | null }) => {
        if (updateError) {
          console.warn(
            '[channel-resolution] access_token GCM upgrade failed:',
            updateError.message
          )
        }
      })
  }

  return createMetaProvider({
    phoneNumberId: metaChannel.phone_number_id,
    accessToken,
  })
}
