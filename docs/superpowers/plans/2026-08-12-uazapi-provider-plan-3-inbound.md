# UAZAPI Provider — Plan 3 (Inbound Processor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the Meta webhook's `processMessage`/`handleStatusUpdate` business logic into a provider-agnostic `src/lib/whatsapp/inbound-processor.ts`, so a later UAZAPI webhook route (Plan 4) can reuse find-or-create-contact, dedupe, flows/automations/AI dispatch, and status mirroring without rewriting any of it.

**Architecture:** `src/app/api/whatsapp/webhook/route.ts` keeps everything Meta-specific — HMAC signature verification, `meta_channels` lookup by `phone_number_id`, and Meta payload parsing (`parseMessageContent`, unchanged). It translates each parsed message into a `NormalizedInboundMessage` and hands it to `processInboundMessage()`, which owns everything after that: contact/conversation dedupe, reactions, idempotent insert, flows/automations/AI/webhook fan-out. `handleStatusUpdate` moves alongside it since it's already provider-agnostic (keys only on `message_id`) and the design spec calls for both routes to share it.

**Tech Stack:** TypeScript, Next.js route handlers, Supabase (`@supabase/supabase-js`), Vitest.

## Global Constraints

- Zero observable behavior change for the Meta webhook's existing traffic, with one deliberate exception: `conversations.channel_id` gets written on inbound (see below) — that column is new (Plan 1) and unused until now, so writing it doesn't change anything a user can currently observe, but it is new *code* behavior worth calling out.
- New deliberate behavior: `processInboundMessage` pins `conversations.channel_id` to the inbound event's `channelId` whenever it differs — implementing the design spec's "canal mais recente usado com esse contato" rule (data-model section) and the routing rule's step 1 (`conversation.channel_id`, se setado), both already relied upon by Plan 2's `resolveChannelForSend` but never written by anything until now. Skipped when already equal, so the current single-Meta-channel-per-account traffic writes it once per conversation and never again.
- `processInboundMessage(db, msg)` and `handleStatusUpdate(db, status)` take the Supabase client as an explicit first parameter rather than reaching for a module-level singleton — matches the convention Plan 2 established (`resolveChannelForSend(db, ...)`, `send-message.ts`, `broadcast-core.ts`) for testability. This is a deliberate, minor deviation from the design spec's illustrative `processInboundMessage(msg)` signature.
- `messages.channel_id` gets stamped on every inbound insert (`msg.channelId`) — mirrors what Plan 2 already does for every outbound insert.
- No new migration. `channels`, `meta_channels`, `conversations.channel_id`, `messages.channel_id` all already exist from Plan 1 (migration `039_whatsapp_channels.sql`).
- UAZAPI's own webhook route is explicitly out of scope (Plan 4) — this plan only builds the shared processor and rewires the existing Meta route onto it.
- `npm run typecheck` and the full Vitest suite must stay green throughout (819 pre-existing tests pass minus the 5 known-unrelated baseline failures: `currency.test.ts` ×3, `dashboard/date-utils.test.ts` ×2 — timezone/locale-dependent, not touched by this plan).

---

## File Structure

- **Create:** `src/lib/whatsapp/inbound-processor.ts` — `NormalizedInboundMessage` type, `processInboundMessage()`, `handleStatusUpdate()`, and every private helper `processMessage`/`handleStatusUpdate` used today (contact/conversation dedupe, reaction handling, reply-context lookup, broadcast-reply flagging, status ladder).
- **Create:** `src/lib/whatsapp/inbound-processor.test.ts` — direct unit tests against the two exported functions using `NormalizedInboundMessage` fixtures (per the design spec's testing section).
- **Modify:** `src/app/api/whatsapp/webhook/route.ts` — `processWebhook()`'s message loop now queries `meta_channels` (not the `whatsapp_config` compatibility view), builds a `NormalizedInboundMessage` per message, and calls the processor. All the extracted local functions are deleted. `parseMessageContent` (Meta-specific) and the GET verification handler are untouched.
- **Modify:** `src/app/api/whatsapp/webhook/route.test.ts` — fixture's `whatsapp_config` case renamed to `meta_channels` (adds `channel_id`), `conversations` mock case gains an `update` handler (the new channel-pin write needs it or every existing test throws `update is not a function`).

## Interfaces

```ts
// src/lib/whatsapp/inbound-processor.ts

export interface NormalizedInboundMessage {
  channelId: string
  accountId: string
  configOwnerUserId: string
  from: string                    // E.164
  contactName: string
  waMessageId: string
  timestamp: string                // unix seconds, as a string
  type:
    | 'text' | 'image' | 'video' | 'document' | 'audio'
    | 'location' | 'reaction' | 'interactive'
  text?: string
  mediaUrl?: string
  interactiveReplyId?: string
  /** Swipe-reply parent for every type except 'reaction'; the
   *  reaction's own target message when type === 'reaction'. */
  replyToWaMessageId?: string
  /** type === 'reaction' only. Absent/empty = removal. */
  reactionEmoji?: string
}

export async function processInboundMessage(
  db: SupabaseClient,
  msg: NormalizedInboundMessage,
): Promise<{ consumed: boolean }>

export async function handleStatusUpdate(
  db: SupabaseClient,
  status: { id: string; status: string; timestamp: string; recipient_id: string },
): Promise<void>
```

Task 2 (`route.ts`) consumes both exports plus the `NormalizedInboundMessage` type (as a type-only import for its own `normalizeMessageType()` helper's return type).

---

### Task 1: `inbound-processor.ts` — the shared processor

**Files:**
- Create: `src/lib/whatsapp/inbound-processor.ts`
- Create: `src/lib/whatsapp/inbound-processor.test.ts`

**Interfaces:**
- Consumes: `findExistingContact`/`isUniqueViolation` (`@/lib/contacts/dedupe`), `reopenClosedConversation` (`@/lib/conversations/reopen`), `runAutomationsForTrigger` (`@/lib/automations/engine`), `dispatchInboundToFlows` (`@/lib/flows/engine`), `dispatchInboundToAiReply` (`@/lib/ai/auto-reply`), `dispatchWebhookEvent` (`@/lib/webhooks/deliver`) — all pre-existing, signatures unchanged, only the import site moves.
- Produces: `NormalizedInboundMessage`, `processInboundMessage(db, msg)`, `handleStatusUpdate(db, status)` — frozen per the Interfaces section above, consumed by Task 2.

- [ ] **Step 1: Write `inbound-processor.ts`**

```ts
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
    if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
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
    const conv = msgRow.conversations as { account_id: string } | null
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
    p_last_message_text: contentText || `[${msg.type}]`,
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
```

- [ ] **Step 2: Write `inbound-processor.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  findExistingContact: vi.fn(),
  reopenClosedConversation: vi.fn(),
  state: {
    conversationRows: [] as Record<string, unknown>[],
    conversationUpdateCalls: [] as Record<string, unknown>[],
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    priorCustomerMsgCount: 0,
    replyContextParent: null as { id: string } | null,
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    broadcastRecipients: [] as Record<string, unknown>[],
    messageReactionCalls: { upserts: [] as Record<string, unknown>[], deletes: 0 },
    statusRecipient: null as { id: string; status: string } | null,
    statusMsgRow: null as { conversation_id: string; conversations: { account_id: string } } | null,
    broadcastRecipientUpdateCalls: [] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: h.findExistingContact,
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/conversations/reopen', () => ({
  reopenClosedConversation: h.reopenClosedConversation,
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))

import {
  processInboundMessage,
  handleStatusUpdate,
  type NormalizedInboundMessage,
} from './inbound-processor'

function fakeDb(): SupabaseClient {
  return {
    from(table: string) {
      switch (table) {
        case 'conversations':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({ data: h.state.conversationRows, error: null }),
                  }),
                }),
              }),
            }),
            update: (row: Record<string, unknown>) => {
              h.state.conversationUpdateCalls.push(row)
              return { eq: () => Promise.resolve({ error: null }) }
            },
          }
        case 'messages':
          return {
            select: (columns: string, options?: { head?: boolean }) => {
              if (options?.head) {
                return {
                  eq: () => ({
                    eq: () =>
                      Promise.resolve({ count: h.state.priorCustomerMsgCount, error: null }),
                  }),
                }
              }
              if (columns.includes('conversations(')) {
                // handleStatusUpdate's msgRow lookup.
                return {
                  eq: () => ({
                    limit: () => ({
                      maybeSingle: () =>
                        Promise.resolve({ data: h.state.statusMsgRow, error: null }),
                    }),
                  }),
                }
              }
              // lookupInternalIdByWaId
              return {
                eq: () => ({
                  eq: () => ({
                    maybeSingle: () =>
                      Promise.resolve({ data: h.state.replyContextParent, error: null }),
                  }),
                }),
              }
            },
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options })
              return {
                select: () =>
                  Promise.resolve({ data: h.state.messageUpsertResult, error: null }),
              }
            },
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          }
        case 'broadcast_recipients':
          return {
            select: (columns: string) => {
              if (columns.includes('broadcasts!inner')) {
                // flagBroadcastReplyIfAny
                return {
                  eq: () => ({
                    eq: () => ({
                      in: () => ({
                        order: () => ({
                          limit: () =>
                            Promise.resolve({ data: h.state.broadcastRecipients, error: null }),
                        }),
                      }),
                    }),
                  }),
                }
              }
              // handleStatusUpdate
              return {
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: h.state.statusRecipient, error: null }),
                }),
              }
            },
            update: (row: Record<string, unknown>) => {
              h.state.broadcastRecipientUpdateCalls.push(row)
              return { eq: () => Promise.resolve({ error: null }) }
            },
          }
        case 'message_reactions':
          return {
            upsert: (row: Record<string, unknown>) => {
              h.state.messageReactionCalls.upserts.push(row)
              return Promise.resolve({ error: null })
            },
            delete: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => {
                    h.state.messageReactionCalls.deletes++
                    return Promise.resolve({ error: null })
                  },
                }),
              }),
            }),
          }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    },
  } as unknown as SupabaseClient
}

const BASE_MSG: NormalizedInboundMessage = {
  channelId: 'ch-1',
  accountId: 'acc-1',
  configOwnerUserId: 'user-1',
  from: '15551230000',
  contactName: 'Ada',
  waMessageId: 'wamid.TEST1',
  timestamp: '1700000000',
  type: 'text',
  text: 'hello',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.conversationRows = []
  h.state.conversationUpdateCalls = []
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.upsertCalls = []
  h.state.priorCustomerMsgCount = 0
  h.state.replyContextParent = null
  h.state.rpcCalls = []
  h.state.broadcastRecipients = []
  h.state.messageReactionCalls = { upserts: [], deletes: 0 }
  h.state.statusRecipient = null
  h.state.statusMsgRow = null
  h.state.broadcastRecipientUpdateCalls = []
  h.findExistingContact.mockResolvedValue({ id: 'contact-1', name: 'Ada', phone: '15551230000' })
  h.reopenClosedConversation.mockResolvedValue(false)
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockResolvedValue(undefined)
})

describe('processInboundMessage', () => {
  it('processes a genuine first delivery: stamps channel, pins conversation, fans out', async () => {
    const db = fakeDb()
    const result = await processInboundMessage(db, BASE_MSG)

    expect(result).toEqual({ consumed: false })
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      channel_id: 'ch-1',
      content_type: 'text',
      content_text: 'hello',
      message_id: 'wamid.TEST1',
    })
    expect(h.state.conversationUpdateCalls).toContainEqual({ channel_id: 'ch-1' })
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      db,
      'acc-1',
      'conversation.created',
      expect.objectContaining({ contact_id: 'contact-1' }),
    )
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      db,
      'acc-1',
      'message.received',
      expect.objectContaining({ whatsapp_message_id: 'wamid.TEST1' }),
    )
  })

  it('skips the channel pin write when the conversation already points at this channel', async () => {
    h.state.conversationRows = [{ id: 'conv-2', channel_id: 'ch-1', account_id: 'acc-1' }]
    const db = fakeDb()
    await processInboundMessage(db, BASE_MSG)
    expect(h.state.conversationUpdateCalls).toHaveLength(0)
  })

  it('a replayed delivery is a no-op past the insert', async () => {
    h.state.conversationRows = [{ id: 'conv-2', channel_id: 'ch-1', account_id: 'acc-1' }]
    h.state.messageUpsertResult = []
    const db = fakeDb()
    const result = await processInboundMessage(db, BASE_MSG)

    expect(result).toEqual({ consumed: false })
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('stores an inbound reaction without touching messages', async () => {
    h.state.conversationRows = [{ id: 'conv-2', channel_id: 'ch-1', account_id: 'acc-1' }]
    h.state.replyContextParent = { id: 'internal-msg-1' }
    const db = fakeDb()
    const result = await processInboundMessage(db, {
      ...BASE_MSG,
      type: 'reaction',
      text: undefined,
      replyToWaMessageId: 'wamid.TARGET',
      reactionEmoji: '👍',
    })

    expect(result).toEqual({ consumed: false })
    expect(h.state.upsertCalls).toHaveLength(0)
    expect(h.state.messageReactionCalls.upserts).toEqual([
      expect.objectContaining({ message_id: 'internal-msg-1', emoji: '👍' }),
    ])
  })

  it('removes a reaction when the emoji is absent', async () => {
    h.state.conversationRows = [{ id: 'conv-2', channel_id: 'ch-1', account_id: 'acc-1' }]
    h.state.replyContextParent = { id: 'internal-msg-1' }
    const db = fakeDb()
    await processInboundMessage(db, {
      ...BASE_MSG,
      type: 'reaction',
      text: undefined,
      replyToWaMessageId: 'wamid.TARGET',
      reactionEmoji: undefined,
    })

    expect(h.state.messageReactionCalls.deletes).toBe(1)
  })

  it('routes an interactive reply to flows with the reply_id/title shape', async () => {
    h.state.conversationRows = [{ id: 'conv-2', channel_id: 'ch-1', account_id: 'acc-1' }]
    const db = fakeDb()
    await processInboundMessage(db, {
      ...BASE_MSG,
      type: 'interactive',
      text: 'Existing customer',
      interactiveReplyId: 'OPT_EXISTING',
    })

    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          kind: 'interactive_reply',
          reply_id: 'OPT_EXISTING',
          reply_title: 'Existing customer',
          meta_message_id: 'wamid.TEST1',
        },
      }),
    )
  })
})

describe('handleStatusUpdate', () => {
  it('mirrors a valid forward transition onto broadcast_recipients and fans out', async () => {
    h.state.statusRecipient = { id: 'rec-1', status: 'sent' }
    h.state.statusMsgRow = { conversation_id: 'conv-1', conversations: { account_id: 'acc-1' } }
    const db = fakeDb()

    await handleStatusUpdate(db, {
      id: 'wamid.TEST1',
      status: 'delivered',
      timestamp: '1700000000',
      recipient_id: '15551230000',
    })

    expect(h.state.broadcastRecipientUpdateCalls).toEqual([
      expect.objectContaining({ status: 'delivered', delivered_at: expect.any(String) }),
    ])
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      db,
      'acc-1',
      'message.status_updated',
      expect.objectContaining({ status: 'delivered', whatsapp_message_id: 'wamid.TEST1' }),
    )
  })

  it('refuses to regress a recipient past a terminal state', async () => {
    h.state.statusRecipient = { id: 'rec-1', status: 'read' }
    h.state.statusMsgRow = null
    const db = fakeDb()

    await handleStatusUpdate(db, {
      id: 'wamid.TEST1',
      status: 'failed',
      timestamp: '1700000000',
      recipient_id: '15551230000',
    })

    expect(h.state.broadcastRecipientUpdateCalls).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run the new suite**

Run: `npx vitest run src/lib/whatsapp/inbound-processor.test.ts`
Expected: all tests PASS.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/inbound-processor.ts src/lib/whatsapp/inbound-processor.test.ts
git commit -m "feat: extract provider-agnostic inbound message processor"
```

---

### Task 2: Rewire the Meta webhook route onto the shared processor

**Files:**
- Modify: `src/app/api/whatsapp/webhook/route.ts` (full-file rewrite — see rationale below)
- Modify: `src/app/api/whatsapp/webhook/route.test.ts`

**Interfaces:**
- Consumes: `processInboundMessage(db, msg)`, `handleStatusUpdate(db, status)`, `NormalizedInboundMessage` (type-only) from `@/lib/whatsapp/inbound-processor` (Task 1).
- Produces: nothing new — this is the last call site touched by this plan.

This task replaces the *entire* file content rather than a series of find/replace edits: the deletions (old `processMessage`, its 6 private helpers, the status-ladder trio) are interleaved with code that stays (`parseMessageContent`, the GET handler, `WhatsAppMessage`/`WhatsAppWebhookEntry`), so a full rewrite is less error-prone than dozens of fragile fragment edits. Every kept function's body is copied verbatim from the current file — only the message-loop body inside `processWebhook()` changes, plus two new small pieces (`normalizeMessageType()` and the trimmed import list).

- [ ] **Step 1: Read the current file for reference**

Run: `cat src/app/api/whatsapp/webhook/route.ts` (or open it) — you'll be replacing it wholesale; the `WhatsAppMessage`/`WhatsAppWebhookEntry` interfaces, the `GET` handler, the `POST` handler, and `parseMessageContent()` are copied through unchanged.

- [ ] **Step 2: Replace `route.ts` with the following**

```ts
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import {
  processInboundMessage,
  handleStatusUpdate,
  type NormalizedInboundMessage,
} from '@/lib/whatsapp/inbound-processor'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
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

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /**
   * Set when the customer taps a QUICK_REPLY button on a *template*
   * message — a broadcast, or any template send. Meta uses a different
   * envelope from `interactive` above: `type: 'button'`, the label in
   * `button.text`, and the payload configured on the template's button
   * in `button.payload` (Meta's own template editor doesn't ask for a
   * payload and mirrors the label into it).
   */
  button?: { text?: string; payload?: string }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate inserts), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached `processWebhook(body)`
  // promise: on serverless platforms (we run on Vercel) the function can
  // be frozen or terminated the moment the response is sent, so a floating
  // promise's DB writes are not guaranteed to finish. That dropped a
  // non-deterministic *subset* of inbound messages — contacts/conversations
  // were created but the message insert never landed, leaving conversations
  // that show in the inbox with an empty thread, and no logs to explain it
  // (see issue #301). `after()` hands the callback to the runtime, which
  // keeps the function alive until it resolves (within the route's
  // maxDuration).
  after(async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error('Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

const NORMALIZED_MESSAGE_TYPES = new Set([
  'text', 'image', 'video', 'document', 'audio', 'location', 'interactive',
])

/**
 * Map a raw Meta message.type onto NormalizedInboundMessage's fixed type
 * union — the same mapping the old inline `contentType` calculation did
 * for the messages.content_type CHECK constraint: stickers are images,
 * template quick-reply taps are interactive, anything else unrecognized
 * falls back to text (parseMessageContent already turned it into a
 * "[Unsupported message type: X]" contentText).
 */
function normalizeMessageType(type: string): NormalizedInboundMessage['type'] {
  if (NORMALIZED_MESSAGE_TYPES.has(type)) {
    return type as NormalizedInboundMessage['type']
  }
  if (type === 'sticker') return 'image'
  if (type === 'button') return 'interactive'
  return 'text'
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          supabaseAdmin(),
        )
        continue
      }

      const value = change.value

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(supabaseAdmin(), status)
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      // Find the account's channel by phone_number_id. `.single()` returns
      // PGRST116 for both 0 rows AND ≥2 rows — distinguish them so
      // operators see the real cause in logs. ≥2 rows shouldn't happen
      // (UNIQUE constraint on phone_number_id), but a row created before
      // the constraint, or a race, would still surface here.
      const { data: channelRows, error: channelError } = await supabaseAdmin()
        .from('meta_channels')
        .select('*')
        .eq('phone_number_id', phoneNumberId)

      if (channelError) {
        console.error(
          'Error fetching meta_channels for phone_number_id:',
          phoneNumberId,
          channelError
        )
        continue
      }

      if (!channelRows || channelRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      if (channelRows.length > 1) {
        console.error(
          `Multiple configs (${channelRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
          'Account owners:',
          channelRows.map((r: { account_id: string; user_id: string }) => `${r.account_id} (admin ${r.user_id})`)
        )
        continue
      }

      const metaChannel = channelRows[0]
      const decryptedAccessToken = decrypt(metaChannel.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        const base = {
          channelId: metaChannel.channel_id as string,
          // Tenancy — drives every contact / conversation lookup and
          // the engines' active-run dispatch.
          accountId: metaChannel.account_id as string,
          // Sender-of-record — always the admin who saved the config.
          configOwnerUserId: metaChannel.user_id as string,
          from: normalizePhone(message.from),
          contactName: contact.profile.name,
          waMessageId: message.id,
          timestamp: message.timestamp,
        }

        if (message.type === 'reaction') {
          await processInboundMessage(supabaseAdmin(), {
            ...base,
            type: 'reaction',
            replyToWaMessageId: message.reaction?.message_id,
            reactionEmoji: message.reaction?.emoji || undefined,
          })
          continue
        }

        const parsed = await parseMessageContent(message, decryptedAccessToken)

        await processInboundMessage(supabaseAdmin(), {
          ...base,
          type: normalizeMessageType(message.type),
          text: parsed.contentText ?? undefined,
          mediaUrl: parsed.mediaUrl ?? undefined,
          interactiveReplyId: parsed.interactiveReplyId ?? undefined,
          replyToWaMessageId: message.context?.id,
        })
      }
    }
  }
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  const verifyAndBuildUrl = async (
    mediaId: string
  ): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. normalizeMessageType() maps the
      // NormalizedInboundMessage type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    case 'button': {
      // Quick-reply tap on a TEMPLATE message. Meta delivers these under
      // their own `button` envelope rather than `interactive` above, so
      // without this case they fell through to `default` and landed in
      // the inbox as "[Unsupported message type: button]" with a null
      // interactiveReplyId — which also meant the Flows engine and the
      // `interactive_reply` automation trigger never saw the tap, so
      // nothing chained off a broadcast reply (issue #478).
      //
      // `payload` is the stable value (the analogue of
      // `button_reply.id`); `text` is the visible label. Prefer the
      // payload for routing and the label for display, each falling
      // back to the other since a template may carry only one.
      const payload = message.button?.payload || null
      const label = message.button?.text || null
      return {
        ...empty,
        contentText: label || payload,
        interactiveReplyId: payload || label,
      }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}
```

- [ ] **Step 3: Update `route.test.ts`'s Supabase fake — table rename + new `conversations.update` handler**

Open `src/app/api/whatsapp/webhook/route.test.ts`. Two changes to the `vi.mock('@supabase/supabase-js', ...)` block:

Find:
```ts
        case 'whatsapp_config':
          return {
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: [
                    {
                      account_id: 'acc-1',
                      user_id: 'user-1',
                      access_token: 'enc',
                    },
                  ],
                  error: null,
                }),
            }),
          }
        case 'conversations':
          // findOrCreateConversation: select().eq().eq().order().limit()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [h.state.conversation],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
          }
```

Replace with:
```ts
        case 'meta_channels':
          return {
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: [
                    {
                      account_id: 'acc-1',
                      user_id: 'user-1',
                      access_token: 'enc',
                      channel_id: 'ch-1',
                    },
                  ],
                  error: null,
                }),
            }),
          }
        case 'conversations':
          // findOrCreateConversation: select().eq().eq().order().limit()
          // The channel-pin write in processInboundMessage also lands
          // here: update().eq().
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [h.state.conversation],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
            update: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
          }
```

- [ ] **Step 4: Run the existing suite — confirm zero regressions**

Run: `npx vitest run src/app/api/whatsapp/webhook/route.test.ts`
Expected: all tests PASS (same assertions as before this plan — this is a black-box test of `POST`, and the observable behavior is unchanged apart from the new channel-pin write, which no existing assertion checks against).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/webhook/route.ts src/app/api/whatsapp/webhook/route.test.ts
git commit -m "refactor: rewire Meta webhook onto the shared inbound processor"
```

---

### Task 3: Final regression + spec status + commit

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-uazapi-provider-design.md` (status line only)

**Interfaces:** None — this task only runs verification and updates documentation.

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: same pass count as the pre-plan baseline plus the new `inbound-processor.test.ts` tests — i.e. 816 + (new test count) passed, the same 5 pre-existing unrelated failures (`currency.test.ts` ×3, `dashboard/date-utils.test.ts` ×2). No new failures.

- [ ] **Step 3: Update the design spec's status line**

Find (in `docs/superpowers/specs/2026-08-10-uazapi-provider-design.md`):
```
Status: Plano 2 (camada de envio) implementado
```

Replace with:
```
Status: Plano 3 (entrada/inbound) implementado
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-10-uazapi-provider-design.md
git commit -m "docs: mark plan 3 (inbound processor) implemented"
```

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** The design spec's "Entrada (inbound)" section is fully covered — `NormalizedInboundMessage` matches the spec's field list exactly (plus the deliberate `db`-as-first-arg deviation noted in Global Constraints), `processInboundMessage` and `handleStatusUpdate` are both shared and reusable by the future UAZAPI route, and the Meta route now builds the normalized shape from its own payload parsing exactly as the spec describes ("parse do formato Meta ... monta o NormalizedInboundMessage ... chama o processor"). The UAZAPI webhook route itself is explicitly out of scope (Plan 4).
- **Placeholder scan:** No task contains TBD/"handle appropriately"/unshown code — every step has the complete file content or complete find/replace text.
- **Type consistency:** `NormalizedInboundMessage`'s field names and `processInboundMessage`/`handleStatusUpdate` signatures are identical across Task 1 (definition), Task 1's test file, and Task 2 (consumer) — checked by hand against the Interfaces section above.
