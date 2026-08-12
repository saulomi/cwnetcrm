// ============================================================
// Shared inbound-message processing — provider-agnostic.
//
// Both webhook routes (Meta today, UAZAPI in a later plan) parse their
// own payload format, then hand a NormalizedInboundMessage to
// processInboundMessage. Everything after "we know what arrived" —
// find-or-create contact/conversation, reactions, dedupe/idempotency,
// flows dispatch, automations, AI auto-reply, webhook fan-out — lives
// here exactly once.
//
// handleStatusUpdate lives here too: it already keys only on
// `message_id`, so it was always provider-agnostic — it just hadn't
// been given a shared home yet.
//
// See docs/superpowers/specs/2026-08-10-uazapi-provider-design.md,
// section "Entrada (inbound) — processor compartilhado".
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

/**
 * One inbound WhatsApp event, already translated out of whichever
 * provider's wire format delivered it. Everything below this point is
 * provider-agnostic.
 */
export interface NormalizedInboundMessage {
  /** channels.id this event arrived on. */
  channelId: string
  /** Tenancy — drives every contact/conversation/message row. */
  accountId: string
  /** Sender-of-record for inserts needing a NOT NULL user_id FK. */
  configOwnerUserId: string
  /** Sender's phone, E.164. */
  from: string
  contactName: string
  /** Provider-side message id (Meta's wamid, UAZAPI's id). */
  waMessageId: string
  /** Unix seconds, as a string — matches Meta's wire format. */
  timestamp: string
  type:
    | 'text'
    | 'image'
    | 'video'
    | 'document'
    | 'audio'
    | 'location'
    | 'reaction'
    | 'interactive'
  text?: string
  /** Already resolved/proxied — never a provider-auth-gated URL. */
  mediaUrl?: string
  /** Stable id of a tapped button/list row; drives Flows routing. */
  interactiveReplyId?: string
  /**
   * Provider message id this event refers to: the swipe-reply parent
   * for every type except 'reaction', where it's the reaction's target
   * message instead.
   */
  replyToWaMessageId?: string
  /** type === 'reaction' only. Empty/absent means the reaction was removed. */
  reactionEmoji?: string
  /**
   * Raw provider-side type string (e.g. Meta's 'sticker'/'button'), used
   * only for the last-message-preview fallback text — kept separate from
   * the normalized `type` so that text stays provider-faithful.
   */
  providerType?: string
}

// ============================================================
// Contact / conversation dedupe — provider-agnostic tenancy anchors.
// Ported verbatim from the Meta webhook's old processMessage helpers,
// parameterized on `db` instead of a module-level admin client.
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processInboundMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(db, accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[inbound-processor] Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[inbound-processor] Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('[inbound-processor] Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

// ============================================================
// Reactions, reply-context, broadcast-reply flag, status ladder.
// ============================================================

/**
 * Resolve a provider-side message id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByWaId(
  db: SupabaseClient,
  waMessageId: string,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('message_id', waMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound-processor] lookupInternalIdByWaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert/delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200.
 */
async function handleReaction(
  db: SupabaseClient,
  msg: NormalizedInboundMessage,
  conversationId: string,
  contactId: string,
) {
  const targetWaMessageId = msg.replyToWaMessageId
  if (!targetWaMessageId) return

  const targetInternalId = await lookupInternalIdByWaId(db, targetWaMessageId, conversationId)
  if (!targetInternalId) {
    console.warn(
      '[inbound-processor] reaction target message not found; skipping',
      targetWaMessageId,
    )
    return
  }

  // Empty/absent emoji = removal.
  if (!msg.reactionEmoji) {
    const { error: delError } = await db
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[inbound-processor] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await db
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: msg.reactionEmoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' },
    )
  if (upsertError) {
    console.error('[inbound-processor] reaction upsert failed:', upsertError.message)
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Best-effort — failures here must not break the main inbound flow.
 */
async function flagBroadcastReplyIfAny(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
) {
  try {
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('[inbound-processor] Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('[inbound-processor] flagBroadcastReplyIfAny failed:', err)
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once a message
// has been delivered or the customer has read or replied, a later
// "failed" status event is a bug in the provider's pipeline or a spoof
// attempt and must be ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

/**
 * Provider-agnostic status mirror — operates only on `message_id`, so
 * every webhook route can share it once it's pulled status/id/timestamp/
 * recipient_id out of its own payload format.
 */
export async function handleStatusUpdate(
  db: SupabaseClient,
  status: {
    id: string
    status: string
    timestamp: string
    recipient_id: string
  },
): Promise<void> {
  // 1) Mirror onto messages. No `.select()`: message_id is NOT unique
  //    (ids repeat across numbers), so this updates 0..N rows and must
  //    not assume a single row.
  const { error: msgErr } = await db
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)

  if (msgErr) {
    console.error('[inbound-processor] Error updating message status:', msgErr)
  }

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id. The
  //    aggregate trigger on broadcast_recipients re-derives the parent
  //    broadcast's sent/delivered/read/failed counts automatically.
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await db
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('[inbound-processor] Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent') update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await db
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('[inbound-processor] Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends). Runs
  //    last so a slow subscriber can't delay the mirrors above. Bounded
  //    to one row (message_id isn't unique) purely to resolve the
  //    owning account for delivery.
  const { data: msgRow } = await db
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', status.id)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as unknown as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(db, accountId, 'message.status_updated', {
        whatsapp_message_id: status.id,
        conversation_id: msgRow.conversation_id,
        status: status.status,
      })
    }
  }
}

// ============================================================
// Main entry point.
// ============================================================

/**
 * Process one normalized inbound event end to end: find-or-create
 * contact/conversation, pin the conversation's channel, reactions,
 * idempotent message insert, flows/automations/AI dispatch, webhook
 * fan-out.
 *
 * Returns `{ consumed: true }` when a Flow run consumed the message
 * (advanced or started) — the one meaningful signal left once
 * processing finishes.
 */
export async function processInboundMessage(
  db: SupabaseClient,
  msg: NormalizedInboundMessage,
): Promise<{ consumed: boolean }> {
  const contactOutcome = await findOrCreateContact(
    db,
    msg.accountId,
    msg.configOwnerUserId,
    msg.from,
    msg.contactName,
  )
  if (!contactOutcome) return { consumed: false }
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(
    db,
    msg.accountId,
    msg.configOwnerUserId,
    contactRecord.id,
  )
  if (!convResult) return { consumed: false }
  const conversation = convResult.conversation

  // Pin the conversation to the channel this contact most recently used
  // to reach us — the routing rule's step 1 (design spec, "Escolha de
  // canal"). Skipped when already pinned, so the common
  // single-channel-per-account case (all of today's traffic) writes
  // this once per conversation and then never again.
  if (conversation.channel_id !== msg.channelId) {
    const { error: pinError } = await db
      .from('conversations')
      .update({ channel_id: msg.channelId })
      .eq('id', conversation.id)
    if (pinError) {
      console.error('[inbound-processor] channel pin update failed:', pinError.message)
    }
  }

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened
  // by a reaction still fires the event, and a subscriber always sees
  // the thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(db, msg.accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages. We never
  // insert into `messages`, never bump unread_count, never update
  // last_message_text.
  if (msg.type === 'reaction') {
    await handleReaction(db, msg, conversation.id, contactRecord.id)
    return { consumed: false }
  }

  const contentText = msg.text ?? null
  const mediaUrl = msg.mediaUrl ?? null
  const interactiveReplyId = msg.interactiveReplyId ?? null

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (msg.replyToWaMessageId) {
    replyToInternalId = await lookupInternalIdByWaId(
      db,
      msg.replyToWaMessageId,
      conversation.id,
    )
    if (!replyToInternalId) {
      console.warn(
        '[inbound-processor] reply context parent not found:',
        msg.replyToWaMessageId,
      )
    }
  }

  // msg.type is already normalized to the messages.content_type CHECK
  // constraint's allowed set by the caller (each webhook route's own
  // parser) — no further mapping needed here. ('reaction' never reaches
  // this point — handled above.)
  const contentType = msg.type

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate.
  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Idempotent insert. Providers retry webhook deliveries, and each
  // retry replays the exact same message id. The unique index on
  // (conversation_id, message_id) makes a replay conflict;
  // `ignoreDuplicates` turns that into an ON CONFLICT DO NOTHING, and
  // the `.select()` then returns the inserted row ONLY on a genuine
  // first insert — an empty result means this delivery was a replay.
  // This is the single idempotency boundary that must sit BEFORE the
  // unread bump and all downstream fan-out below (issue #367).
  const { data: insertedRows, error: msgError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        message_id: msg.waMessageId,
        status: 'delivered',
        created_at: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
        reply_to_message_id: replyToInternalId,
        interactive_reply_id: interactiveReplyId,
        channel_id: msg.channelId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')

  if (msgError) {
    console.error('[inbound-processor] Error inserting message:', msgError)
    return { consumed: false }
  }

  // Replayed delivery: acknowledge as a no-op. Returning here is what
  // keeps a retry from double-bumping unread, re-advancing flows,
  // re-firing automations, re-invoking AI handling, and re-dispatching
  // public webhooks (issue #367).
  if (!insertedRows || insertedRows.length === 0) {
    console.info(
      '[inbound-processor] duplicate inbound message ignored (idempotent replay):',
      msg.waMessageId,
    )
    return { consumed: false }
  }

  // Unread bump + last-message summary, done DB-side so two concurrent
  // inbound deliveries for the same conversation can't lose an
  // increment (issue #369).
  const { error: convError } = await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText || `[${msg.providerType ?? msg.type}]`,
  })
  if (convError) {
    console.error('[inbound-processor] Error updating conversation:', convError)
  }

  // A customer writing again re-opens the thread (issue #409).
  await reopenClosedConversation(db, conversation)

  // If this contact was a recent broadcast recipient, flag the reply so
  // the broadcast's `replied_count` advances.
  await flagBroadcastReplyIfAny(db, msg.accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch. If the runner consumes the message, we
  // suppress the content-level automation triggers for this inbound —
  // the customer is navigating the bot menu, not sending a fresh
  // trigger word that should fork into automations. The
  // relationship-level triggers still fire even when consumed.
  // ============================================================
  const flowResult = await dispatchInboundToFlows({
    accountId: msg.accountId,
    userId: msg.configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: msg.waMessageId,
          }
        : {
            kind: 'text',
            text: contentText ?? '',
            meta_message_id: msg.waMessageId,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this inbound event. All
  // dispatches run here so the contact, conversation, and inbound
  // message all exist before any step runs.
  const inboundText = contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId: msg.accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[inbound-processor][automations] dispatch failed:', err))
  }

  // AI auto-reply. Only for plain-text inbound the deterministic flow
  // runner did NOT consume, and only when the account has enabled it.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId: msg.accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId: msg.configOwnerUserId,
    })
  }

  // message.received webhook (public API). conversation.created is
  // emitted earlier, right after the thread is opened.
  await dispatchWebhookEvent(db, msg.accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: msg.waMessageId,
    content_type: contentType,
    text: contentText,
  })

  return { consumed: flowConsumed }
}
