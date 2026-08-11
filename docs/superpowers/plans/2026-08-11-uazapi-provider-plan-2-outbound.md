# UAZAPI Multi-Provider WhatsApp — Plan 2/5: Outbound Send Layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `WhatsAppProvider` abstraction and a channel-resolution layer, then re-point every existing Meta send call-site (dashboard send, public-API send, broadcasts + resume, Flows engine, Automations engine) through it — with zero change in observable behavior for Meta, and the plumbing UAZAPI's own provider (Plan 4) will plug into.

**Architecture:** `src/lib/whatsapp/provider.ts` defines the `WhatsAppProvider` interface (sendText/sendMedia/sendTemplate/sendInteractiveButtons/sendInteractiveList/verifyConnection). `src/lib/whatsapp/meta-provider.ts` implements it as a thin, logic-free wrapper over the existing `meta-api.ts` functions. `src/lib/whatsapp/channel-resolution.ts` resolves which `channels` row an outbound send uses (conversation's pinned channel → account default → error) and builds that channel's provider, centralizing the credential-decrypt + legacy-ciphertext-upgrade logic that today is duplicated (and, in two of five call sites, half-missing) across every sender. Every call site keeps its own business logic (validation, phone-variant retry, DB persistence, flow-pause) untouched — only the "load config, call meta-api directly" step is replaced with "resolve channel, call provider".

**Tech Stack:** TypeScript, Supabase (`@supabase/supabase-js`), Vitest.

## Global Constraints

- Zero behavior change for Meta: every existing test that passes today must still pass with identical assertions on error codes, HTTP statuses, and persisted data — only the internal DB query shape (`whatsapp_config` → `channels` + `meta_channels`) and the identity of the function that calls Meta's API (a `WhatsAppProvider` method instead of a bare `meta-api.ts` function) change.
- `WhatsAppProvider` argument shapes follow Meta's Cloud API model — the only provider this plan implements. Do not generalize the interface speculatively for UAZAPI; that adaptation is Plan 4's job, once UAZAPI's real payload shapes are confirmed against a live instance.
- UAZAPI's own provider implementation (`uazapi-provider.ts`) is explicitly **out of scope** for this plan (Plan 4). `resolveProvider` must still handle a `provider: 'uazapi'` channel gracefully (a clear, typed error), since Plan 1's schema already allows one to exist even though no UI creates one yet.
- Business logic inside each call site (phone-variant retry, contact auto-fix, template body rendering, flow-run pausing, broadcast-recipient stamping, aggregate-count triggers) is NOT touched — only the "look up WhatsApp config, call Meta directly" segment is replaced.
- No new database migration in this plan — all schema this plan needs (`channels`, `meta_channels`, `conversations.channel_id`, `messages.channel_id`) already landed in Plan 1 (`supabase/migrations/039_whatsapp_channels.sql`, on `main`).
- `npm run typecheck` and `npx vitest run` must stay green (same pass/fail counts as the current `main` baseline) after every task.
- Repo root: `C:\Users\Saulo\orca\projects\wacrm`. Node/npm need the merged PATH in PowerShell: `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")`.

---

## File Structure

**Create:**
- `src/lib/whatsapp/provider.ts` — `WhatsAppProvider` interface + its argument/result types.
- `src/lib/whatsapp/meta-provider.ts` — `createMetaProvider()`, a thin adapter over `meta-api.ts`.
- `src/lib/whatsapp/meta-provider.test.ts`
- `src/lib/whatsapp/channel-resolution.ts` — `resolveChannelForSend()` (which channel a send uses) + `resolveProvider()` (that channel's credentials → its `WhatsAppProvider`) + `ChannelResolutionError`.
- `src/lib/whatsapp/channel-resolution.test.ts`
- `src/lib/flows/meta-send.test.ts` (no test file exists today for this module)
- `src/lib/automations/meta-send.test.ts` (no test file exists today for this module)

**Modify:**
- `src/lib/whatsapp/send-message.ts` + `send-message.test.ts`
- `src/lib/whatsapp/broadcast-core.ts` + `broadcast-core.test.ts`
- `src/lib/whatsapp/broadcast-resume.ts` + `broadcast-resume.test.ts` (shares `BroadcastPlan`'s shape with `broadcast-core.ts` — must change together)
- `src/lib/flows/meta-send.ts`
- `src/lib/automations/meta-send.ts`
- `docs/superpowers/specs/2026-08-10-uazapi-provider-design.md` (status line, final task)

## Interfaces

```ts
// src/lib/whatsapp/provider.ts
export interface WhatsAppProvider {
  sendText(args: SendTextArgs): Promise<ProviderSendResult>
  sendMedia(args: SendMediaArgs): Promise<ProviderSendResult>
  sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult>
  sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<ProviderSendResult>
  sendInteractiveList(args: SendInteractiveListArgs): Promise<ProviderSendResult>
  verifyConnection(): Promise<ConnectionInfo>
}

// src/lib/whatsapp/meta-provider.ts
export function createMetaProvider(config: { phoneNumberId: string; accessToken: string }): WhatsAppProvider

// src/lib/whatsapp/channel-resolution.ts
export type ChannelResolutionErrorCode = 'not_configured' | 'ambiguous' | 'not_implemented'
export class ChannelResolutionError extends Error { readonly code: ChannelResolutionErrorCode }
export interface ResolvedChannel { channelId: string; provider: 'meta' | 'uazapi' }
export function resolveChannelForSend(db: SupabaseClient, accountId: string, conversationChannelId?: string | null): Promise<ResolvedChannel>
export function resolveProvider(db: SupabaseClient, channel: ResolvedChannel): Promise<WhatsAppProvider>
```

Every later task's implementer consumes `resolveChannelForSend` + `resolveProvider` + `ChannelResolutionError` exactly as declared above — those three names and signatures are frozen after Task 2.

---

### Task 1: `WhatsAppProvider` interface + Meta implementation

**Files:**
- Create: `src/lib/whatsapp/provider.ts`
- Create: `src/lib/whatsapp/meta-provider.ts`
- Test: `src/lib/whatsapp/meta-provider.test.ts`

**Interfaces:**
- Consumes: `MediaKind`, `InteractiveButton`, `InteractiveListSection` (types, from `./meta-api`); `MessageTemplate` (from `@/types`); `SendTimeParams` (from `./template-send-builder`).
- Produces: `WhatsAppProvider`, `SendTextArgs`, `SendMediaArgs`, `SendTemplateArgs`, `SendInteractiveButtonsArgs`, `SendInteractiveListArgs`, `ProviderSendResult`, `ConnectionInfo` (from `provider.ts`); `createMetaProvider` (from `meta-provider.ts`) — every later task imports these.

- [ ] **Step 1: Write `provider.ts`**

```ts
import type { MediaKind, InteractiveButton, InteractiveListSection } from './meta-api'
import type { MessageTemplate } from '@/types'
import type { SendTimeParams } from './template-send-builder'

export interface SendTextArgs {
  to: string
  text: string
  contextMessageId?: string
}

export interface SendMediaArgs {
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export interface SendTemplateArgs {
  to: string
  templateName: string
  language?: string
  params?: string[]
  template?: MessageTemplate
  messageParams?: SendTimeParams
  contextMessageId?: string
}

export interface SendInteractiveButtonsArgs {
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: InteractiveButton[]
  contextMessageId?: string
}

export interface SendInteractiveListArgs {
  to: string
  bodyText: string
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: InteractiveListSection[]
  contextMessageId?: string
}

export interface ProviderSendResult {
  messageId: string
}

export interface ConnectionInfo {
  connected: boolean
  detail?: string
}

/**
 * Shape every WhatsApp send-side integration implements, so the rest of
 * the app (send-message, broadcast-core, the Flows/Automations engines)
 * calls one interface regardless of which provider backs the channel.
 *
 * Argument shapes intentionally follow Meta's Cloud API model — the
 * only provider this plan implements. UAZAPI's own provider (a later
 * plan) adapts UAZAPI's endpoints to this same shape; if UAZAPI's send
 * semantics genuinely can't fit it, that's the point where the
 * interface grows a provider-neutral shape — not before, per YAGNI.
 */
export interface WhatsAppProvider {
  sendText(args: SendTextArgs): Promise<ProviderSendResult>
  sendMedia(args: SendMediaArgs): Promise<ProviderSendResult>
  sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult>
  sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<ProviderSendResult>
  sendInteractiveList(args: SendInteractiveListArgs): Promise<ProviderSendResult>
  verifyConnection(): Promise<ConnectionInfo>
}
```

- [ ] **Step 2: Write the failing test for `meta-provider.ts`**

```ts
// src/lib/whatsapp/meta-provider.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createMetaProvider } from './meta-provider'

const sendTextMessage = vi.fn(async () => ({ messageId: 'wamid.text' }))
const sendMediaMessage = vi.fn(async () => ({ messageId: 'wamid.media' }))
const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.tpl' }))
const sendInteractiveButtons = vi.fn(async () => ({ messageId: 'wamid.btn' }))
const sendInteractiveList = vi.fn(async () => ({ messageId: 'wamid.list' }))
const verifyPhoneNumber = vi.fn(async () => ({
  id: 'pn-1',
  display_phone_number: '+15550000000',
}))

vi.mock('./meta-api', () => ({
  sendTextMessage: (...args: unknown[]) =>
    (sendTextMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendMediaMessage: (...args: unknown[]) =>
    (sendMediaMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendInteractiveButtons: (...args: unknown[]) =>
    (sendInteractiveButtons as unknown as (...a: unknown[]) => unknown)(...args),
  sendInteractiveList: (...args: unknown[]) =>
    (sendInteractiveList as unknown as (...a: unknown[]) => unknown)(...args),
  verifyPhoneNumber: (...args: unknown[]) =>
    (verifyPhoneNumber as unknown as (...a: unknown[]) => unknown)(...args),
}))

const CONFIG = { phoneNumberId: 'pn-1', accessToken: 'tok-1' }

describe('createMetaProvider', () => {
  it('sendText forwards phoneNumberId + accessToken + args to sendTextMessage', async () => {
    const provider = createMetaProvider(CONFIG)
    const result = await provider.sendText({
      to: '+15551234567',
      text: 'hi',
      contextMessageId: 'wamid.parent',
    })
    expect(result).toEqual({ messageId: 'wamid.text' })
    expect(sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '+15551234567',
      text: 'hi',
      contextMessageId: 'wamid.parent',
    })
  })

  it('sendMedia forwards to sendMediaMessage', async () => {
    const provider = createMetaProvider(CONFIG)
    await provider.sendMedia({
      to: '+15551234567',
      kind: 'image',
      link: 'https://x/y.jpg',
      caption: 'cap',
    })
    expect(sendMediaMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '+15551234567',
      kind: 'image',
      link: 'https://x/y.jpg',
      caption: 'cap',
    })
  })

  it('sendTemplate forwards to sendTemplateMessage', async () => {
    const provider = createMetaProvider(CONFIG)
    await provider.sendTemplate({
      to: '+15551234567',
      templateName: 'order_update',
      language: 'en',
      params: ['A123'],
    })
    expect(sendTemplateMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '+15551234567',
      templateName: 'order_update',
      language: 'en',
      params: ['A123'],
    })
  })

  it('sendInteractiveButtons forwards to sendInteractiveButtons', async () => {
    const provider = createMetaProvider(CONFIG)
    await provider.sendInteractiveButtons({
      to: '+15551234567',
      bodyText: 'Pick one',
      buttons: [{ id: 'a', title: 'A' }],
    })
    expect(sendInteractiveButtons).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '+15551234567',
      bodyText: 'Pick one',
      buttons: [{ id: 'a', title: 'A' }],
    })
  })

  it('sendInteractiveList forwards to sendInteractiveList', async () => {
    const provider = createMetaProvider(CONFIG)
    await provider.sendInteractiveList({
      to: '+15551234567',
      bodyText: 'Choose',
      buttonLabel: 'Menu',
      sections: [{ rows: [{ id: 'r1', title: 'Row 1' }] }],
    })
    expect(sendInteractiveList).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
      to: '+15551234567',
      bodyText: 'Choose',
      buttonLabel: 'Menu',
      sections: [{ rows: [{ id: 'r1', title: 'Row 1' }] }],
    })
  })

  it('verifyConnection reports connected on success', async () => {
    const provider = createMetaProvider(CONFIG)
    const info = await provider.verifyConnection()
    expect(info).toEqual({ connected: true })
    expect(verifyPhoneNumber).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
    })
  })

  it('verifyConnection reports disconnected with the error detail on failure', async () => {
    verifyPhoneNumber.mockRejectedValueOnce(new Error('Meta API error: 401'))
    const provider = createMetaProvider(CONFIG)
    const info = await provider.verifyConnection()
    expect(info).toEqual({ connected: false, detail: 'Meta API error: 401' })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/meta-provider.test.ts`
Expected: FAIL — `Cannot find module './meta-provider'`.

- [ ] **Step 4: Write `meta-provider.ts`**

```ts
import {
  sendTextMessage as metaSendText,
  sendMediaMessage as metaSendMedia,
  sendTemplateMessage as metaSendTemplate,
  sendInteractiveButtons as metaSendInteractiveButtons,
  sendInteractiveList as metaSendInteractiveList,
  verifyPhoneNumber,
} from './meta-api'
import type {
  WhatsAppProvider,
  SendTextArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  ProviderSendResult,
  ConnectionInfo,
} from './provider'

export interface MetaProviderConfig {
  phoneNumberId: string
  accessToken: string
}

/**
 * Thin adapter over meta-api.ts's free functions — binds phoneNumberId +
 * accessToken once so callers don't thread them through every send call.
 * Carries zero business logic of its own: every method is a direct
 * pass-through, kept that way deliberately so a `meta-api.test.ts`
 * regression on the underlying function is the only place Meta-specific
 * behaviour needs testing.
 */
export function createMetaProvider(config: MetaProviderConfig): WhatsAppProvider {
  const { phoneNumberId, accessToken } = config

  return {
    async sendText(args: SendTextArgs): Promise<ProviderSendResult> {
      return metaSendText({ phoneNumberId, accessToken, ...args })
    },
    async sendMedia(args: SendMediaArgs): Promise<ProviderSendResult> {
      return metaSendMedia({ phoneNumberId, accessToken, ...args })
    },
    async sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult> {
      return metaSendTemplate({ phoneNumberId, accessToken, ...args })
    },
    async sendInteractiveButtons(
      args: SendInteractiveButtonsArgs
    ): Promise<ProviderSendResult> {
      return metaSendInteractiveButtons({ phoneNumberId, accessToken, ...args })
    },
    async sendInteractiveList(args: SendInteractiveListArgs): Promise<ProviderSendResult> {
      return metaSendInteractiveList({ phoneNumberId, accessToken, ...args })
    },
    async verifyConnection(): Promise<ConnectionInfo> {
      try {
        await verifyPhoneNumber({ phoneNumberId, accessToken })
        return { connected: true }
      } catch (err) {
        return {
          connected: false,
          detail: err instanceof Error ? err.message : 'Unknown error',
        }
      }
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/meta-provider.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/whatsapp/provider.ts src/lib/whatsapp/meta-provider.ts src/lib/whatsapp/meta-provider.test.ts
git commit -m "feat(whatsapp): add WhatsAppProvider interface + Meta implementation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Channel resolution layer

**Files:**
- Create: `src/lib/whatsapp/channel-resolution.ts`
- Test: `src/lib/whatsapp/channel-resolution.test.ts`

**Interfaces:**
- Consumes: `createMetaProvider` (from `./meta-provider`, Task 1); `decrypt`, `encrypt`, `isLegacyFormat` (from `./encryption`, existing); `WhatsAppProvider` (type, from `./provider`, Task 1).
- Produces: `resolveChannelForSend`, `resolveProvider`, `ChannelResolutionError`, `ResolvedChannel` — every refactor task (3–6) imports these three names verbatim.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/whatsapp/channel-resolution.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveChannelForSend, resolveProvider } from './channel-resolution'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace(/^(enc|legacy):/, ''),
  encrypt: (v: string) => `enc:${v}`,
  isLegacyFormat: (v: string) => v.startsWith('legacy:'),
}))

const createMetaProvider = vi.fn(() => ({ sendText: vi.fn() }))
vi.mock('./meta-provider', () => ({
  createMetaProvider: (...args: unknown[]) =>
    (createMetaProvider as unknown as (...a: unknown[]) => unknown)(...args),
}))

// ------------------------------------------------------------
// resolveChannelForSend
// ------------------------------------------------------------

interface ChannelFixture {
  byId?: Record<string, { id: string; provider: 'meta' | 'uazapi' } | null>
  default?: { id: string; provider: 'meta' | 'uazapi' } | null
  connected?: { id: string; provider: 'meta' | 'uazapi' }[]
}

function channelsDb(fx: ChannelFixture): SupabaseClient {
  return {
    from(table: string) {
      if (table !== 'channels') throw new Error(`unexpected table: ${table}`)
      let idFilter: string | undefined
      let defaultFilter = false
      let statusFilter: string | undefined
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'id') idFilter = val as string
          if (col === 'is_default' && val === true) defaultFilter = true
          if (col === 'status') statusFilter = val as string
          return b
        },
        maybeSingle: async () => {
          if (idFilter !== undefined) {
            return { data: fx.byId?.[idFilter] ?? null, error: null }
          }
          if (defaultFilter) {
            return { data: fx.default ?? null, error: null }
          }
          return { data: null, error: null }
        },
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
          if (statusFilter === 'connected') {
            return resolve({ data: fx.connected ?? [], error: null })
          }
          return resolve({ data: [], error: null })
        },
      }
      return b
    },
  } as unknown as SupabaseClient
}

describe('resolveChannelForSend', () => {
  it('uses the conversation channel when it belongs to this account', async () => {
    const db = channelsDb({ byId: { 'ch-1': { id: 'ch-1', provider: 'meta' } } })
    const result = await resolveChannelForSend(db, 'acct-1', 'ch-1')
    expect(result).toEqual({ channelId: 'ch-1', provider: 'meta' })
  })

  it('falls back to the account default when no conversation channel is set', async () => {
    const db = channelsDb({ default: { id: 'ch-default', provider: 'meta' } })
    const result = await resolveChannelForSend(db, 'acct-1', null)
    expect(result).toEqual({ channelId: 'ch-default', provider: 'meta' })
  })

  it('falls back to the account default when the conversation channel is not found', async () => {
    const db = channelsDb({
      byId: { 'ch-gone': null },
      default: { id: 'ch-default', provider: 'meta' },
    })
    const result = await resolveChannelForSend(db, 'acct-1', 'ch-gone')
    expect(result).toEqual({ channelId: 'ch-default', provider: 'meta' })
  })

  it('falls back to the single connected channel when there is no default', async () => {
    const db = channelsDb({ connected: [{ id: 'ch-only', provider: 'meta' }] })
    const result = await resolveChannelForSend(db, 'acct-1', null)
    expect(result).toEqual({ channelId: 'ch-only', provider: 'meta' })
  })

  it('throws not_configured when nothing is connected', async () => {
    const db = channelsDb({})
    await expect(resolveChannelForSend(db, 'acct-1', null)).rejects.toMatchObject({
      code: 'not_configured',
    })
  })

  it('throws ambiguous when several channels are connected and none is default', async () => {
    const db = channelsDb({
      connected: [
        { id: 'ch-a', provider: 'meta' },
        { id: 'ch-b', provider: 'uazapi' },
      ],
    })
    await expect(resolveChannelForSend(db, 'acct-1', null)).rejects.toMatchObject({
      code: 'ambiguous',
    })
  })
})

// ------------------------------------------------------------
// resolveProvider
// ------------------------------------------------------------

interface MetaChannelFixture {
  metaChannel?: Record<string, unknown> | null
}

function metaChannelDb(
  fx: MetaChannelFixture,
  captured: { update?: Record<string, unknown> }
): SupabaseClient {
  return {
    from(table: string) {
      if (table !== 'meta_channels') throw new Error(`unexpected table: ${table}`)
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        single: async () => ({
          data: fx.metaChannel === undefined ? null : fx.metaChannel,
          error: fx.metaChannel === undefined ? { message: 'not found' } : null,
        }),
        update: (row: Record<string, unknown>) => {
          captured.update = row
          return b
        },
        then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }),
      }
      return b
    },
  } as unknown as SupabaseClient
}

describe('resolveProvider', () => {
  it('throws not_implemented for a uazapi channel', async () => {
    await expect(
      resolveProvider({} as SupabaseClient, { channelId: 'ch-1', provider: 'uazapi' })
    ).rejects.toMatchObject({ code: 'not_implemented' })
  })

  it('throws not_configured when the meta_channels row is missing', async () => {
    const db = metaChannelDb({}, {})
    await expect(
      resolveProvider(db, { channelId: 'ch-1', provider: 'meta' })
    ).rejects.toMatchObject({ code: 'not_configured' })
  })

  it('builds a MetaProvider from the decrypted credentials', async () => {
    createMetaProvider.mockClear()
    const db = metaChannelDb(
      { metaChannel: { id: 'mc-1', phone_number_id: 'pn-1', access_token: 'enc:tok-1' } },
      {}
    )
    await resolveProvider(db, { channelId: 'ch-1', provider: 'meta' })
    expect(createMetaProvider).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok-1',
    })
  })

  it('self-heals a legacy-ciphertext token without blocking the send', async () => {
    const captured: { update?: Record<string, unknown> } = {}
    const db = metaChannelDb(
      { metaChannel: { id: 'mc-1', phone_number_id: 'pn-1', access_token: 'legacy:tok-1' } },
      captured
    )
    await resolveProvider(db, { channelId: 'ch-1', provider: 'meta' })
    // Fire-and-forget — give the microtask queue a tick to run it.
    await new Promise((r) => setTimeout(r, 0))
    expect(captured.update?.access_token).toBe('enc:tok-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/channel-resolution.test.ts`
Expected: FAIL — `Cannot find module './channel-resolution'`.

- [ ] **Step 3: Write `channel-resolution.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/channel-resolution.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/channel-resolution.ts src/lib/whatsapp/channel-resolution.test.ts
git commit -m "feat(whatsapp): add channel-resolution layer (channel routing + provider factory)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Refactor `send-message.ts`

**Files:**
- Modify: `src/lib/whatsapp/send-message.ts`
- Modify: `src/lib/whatsapp/send-message.test.ts`

**Interfaces:**
- Consumes: `resolveChannelForSend`, `resolveProvider`, `ChannelResolutionError` (from `./channel-resolution`, Task 2).

- [ ] **Step 1: Update the test fixture + add a failing assertion**

In `send-message.test.ts`, replace the `sendPathDb` helper's `config` object and the table-dispatch branches that reference `whatsapp_config` with `channels` + `meta_channels` equivalents:

Find:
```ts
  const config = {
    id: 'cfg-1',
    phone_number_id: 'pn-1',
    access_token: 'token',
  };

  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversation = row;
          return builder;
        },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => {
          if (table === 'conversations') {
            return { data: conversation, error: null };
          }
          if (table === 'whatsapp_config') return { data: config, error: null };
          if (table === 'messages') {
            return { data: { id: 'msg-1' }, error: null };
          }
          return { data: null, error: null };
        },
```

Replace with:
```ts
  const channel = { id: 'ch-1', provider: 'meta' as const };
  const metaChannel = {
    id: 'mc-1',
    channel_id: 'ch-1',
    phone_number_id: 'pn-1',
    access_token: 'token',
  };

  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversation = row;
          return builder;
        },
        maybeSingle: async () => {
          if (table === 'channels') return { data: channel, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'conversations') {
            return { data: conversation, error: null };
          }
          if (table === 'meta_channels') return { data: metaChannel, error: null };
          if (table === 'messages') {
            return { data: { id: 'msg-1' }, error: null };
          }
          return { data: null, error: null };
        },
```

(Leave the rest of the builder, including its `then` branch, unchanged.)

Then add a new test proving `channel_id` is stamped on the persisted message — append inside the `describe('sendMessageToConversation — template persistence (#483)', ...)` block or as its own `describe`:

```ts
describe('sendMessageToConversation — channel resolution', () => {
  it('stamps the resolved channel_id on the persisted message', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hello',
    });
    expect(captured.message?.channel_id).toBe('ch-1');
  });
});
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `npx vitest run src/lib/whatsapp/send-message.test.ts`
Expected: FAIL on the new test — `captured.message?.channel_id` is `undefined` (send-message.ts doesn't set it yet), and likely other failures too since `send-message.ts` still queries `whatsapp_config`, a table the fixture no longer serves.

- [ ] **Step 3: Refactor `send-message.ts`**

Update the imports at the top:

Find:
```ts
import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
```

Replace with:
```ts
import { type MediaKind } from '@/lib/whatsapp/meta-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import {
  resolveChannelForSend,
  resolveProvider,
  ChannelResolutionError,
} from '@/lib/whatsapp/channel-resolution';
import { supabaseAdmin } from '@/lib/flows/admin-client';
```

Find the WhatsApp config lookup block:
```ts
  // WhatsApp config, account-scoped.
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (configError || !config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const accessToken = decrypt(config.access_token);

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  if (isLegacyFormat(config.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[send-message] access_token GCM upgrade failed:',
            error.message
          );
        }
      });
  }
```

Replace with:
```ts
  // Resolve which channel this send uses (the conversation's pinned
  // channel, else the account default), then build that channel's
  // provider. ChannelResolutionError is remapped to SendMessageError so
  // callers outside this module see the same error shape as before
  // this layer existed (whatsapp_not_configured / 400).
  let resolvedChannel;
  let provider;
  try {
    resolvedChannel = await resolveChannelForSend(
      db,
      accountId,
      conversation.channel_id
    );
    provider = await resolveProvider(db, resolvedChannel);
  } catch (err) {
    if (err instanceof ChannelResolutionError) {
      throw new SendMessageError('whatsapp_not_configured', err.message, 400);
    }
    throw err;
  }
```

Find the `attempt` closure:
```ts
  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: templateName!,
        language: sendLanguage,
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const p = interactivePayload!;
      if (p.kind === 'buttons') {
        const result = await sendInteractiveButtons({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await sendInteractiveList({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };
```

Replace with:
```ts
  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      const result = await provider.sendTemplate({
        to: phone,
        templateName: templateName!,
        language: sendLanguage,
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await provider.sendMedia({
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      const p = interactivePayload!;
      if (p.kind === 'buttons') {
        const result = await provider.sendInteractiveButtons({
          to: phone,
          bodyText: p.body,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          buttons: p.buttons,
          contextMessageId,
        });
        return result.messageId;
      }
      const result = await provider.sendInteractiveList({
        to: phone,
        bodyText: p.body,
        buttonLabel: p.button_label,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        sections: p.sections,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await provider.sendText({
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };
```

Find the `messages` insert and add `channel_id`:
```ts
  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: messageType,
      content_text: persistedText,
      media_url: mediaUrl || null,
      template_name: templateName || null,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
```

Replace with:
```ts
  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: messageType,
      content_text: persistedText,
      media_url: mediaUrl || null,
      template_name: templateName || null,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
      channel_id: resolvedChannel.channelId,
    })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/whatsapp/send-message.test.ts`
Expected: PASS — all existing assertions plus the new `channel_id` one.

- [ ] **Step 5: Typecheck + full regression**

Run: `npm run typecheck`
Run: `npx vitest run`
Expected: no errors; same pass/fail counts as the Task 2 baseline.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/send-message.ts src/lib/whatsapp/send-message.test.ts
git commit -m "refactor(whatsapp): route send-message.ts through the channel-resolution layer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Refactor `broadcast-core.ts` + `broadcast-resume.ts`

These two files share `BroadcastPlan`'s shape (`broadcast-resume.ts` builds one, `broadcast-core.ts`'s `deliverBroadcast` consumes it) — they must change together.

**Files:**
- Modify: `src/lib/whatsapp/broadcast-core.ts`
- Modify: `src/lib/whatsapp/broadcast-core.test.ts`
- Modify: `src/lib/whatsapp/broadcast-resume.ts`
- Modify: `src/lib/whatsapp/broadcast-resume.test.ts`

**Interfaces:**
- Consumes: `resolveChannelForSend`, `resolveProvider`, `ChannelResolutionError` (from `./channel-resolution`, Task 2); `WhatsAppProvider` (type, from `./provider`, Task 1).
- Produces: `BroadcastPlan` now carries `channelId: string; provider: WhatsAppProvider` instead of `phoneNumberId: string; accessToken: string`.

- [ ] **Step 1: Update `broadcast-core.test.ts`'s fixture + assertions**

Find the `makeDb` helper's `whatsapp_config` branch:
```ts
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { phone_number_id: 'pn-1', access_token: 'enc' },
                  error: null,
                }),
            }),
          }),
        };
      }
```

Replace with:
```ts
      if (table === 'channels') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: { id: 'ch-1', provider: 'meta' },
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      if (table === 'meta_channels') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: 'mc-1', phone_number_id: 'pn-1', access_token: 'enc' },
                  error: null,
                }),
            }),
          }),
        };
      }
```

Update the encryption mock at the top of the file:

Find:
```ts
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
}));
```

Replace with:
```ts
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
```

The `createBroadcast` test still asserts `plan.broadcastId`, `plan.planned`, `calls.rpc`, `calls.usedDirectInsert` — those are unaffected. No `plan.phoneNumberId`/`plan.accessToken` assertion exists in this file today, so no assertion needs to change here (unlike `broadcast-resume.test.ts` below).

- [ ] **Step 2: Update `broadcast-resume.test.ts`'s fixture + assertions**

Find the `PlanFixture` interface and `CONFIG` constant:
```ts
interface PlanFixture {
  broadcast?: Record<string, unknown> | null;
  recipients?: Record<string, unknown>[];
  config?: Record<string, unknown> | null;
  templates?: Record<string, unknown>[];
}
```
and
```ts
const CONFIG = { phone_number_id: 'pn-1', access_token: 'tok' };
```

Replace with:
```ts
interface PlanFixture {
  broadcast?: Record<string, unknown> | null;
  recipients?: Record<string, unknown>[];
  channel?: Record<string, unknown> | null;
  metaChannel?: Record<string, unknown> | null;
  templates?: Record<string, unknown>[];
}
```
and
```ts
const CHANNEL = { id: 'ch-1', provider: 'meta' as const };
const META_CHANNEL = { id: 'mc-1', phone_number_id: 'pn-1', access_token: 'tok' };
```

Find `planDb`'s body and update the `maybeSingle`/`single` branches to dispatch by table:

Find:
```ts
        maybeSingle: async () => ({
          data: fx.broadcast === undefined ? null : fx.broadcast,
          error: null,
        }),
        single: async () => ({
          data: fx.config === undefined ? null : fx.config,
          error: null,
        }),
```

Replace with:
```ts
        maybeSingle: async () => {
          if (table === 'broadcasts') {
            return { data: fx.broadcast === undefined ? null : fx.broadcast, error: null };
          }
          if (table === 'channels') {
            return { data: fx.channel === undefined ? null : fx.channel, error: null };
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'meta_channels') {
            return { data: fx.metaChannel === undefined ? null : fx.metaChannel, error: null };
          }
          return { data: null, error: null };
        },
```

Update the encryption mock:

Find:
```ts
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}));
```

Replace with:
```ts
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
```

Replace every `config: CONFIG` in a `planDb({...})` call with `channel: CHANNEL, metaChannel: META_CHANNEL` (there are 7 call sites in the file — every `planDb({ broadcast: ..., config: CONFIG, ... })` and the two bare `planDb({ broadcast: BROADCAST, config: CONFIG, recipients: [...] })` calls in the "scopes to failed rows" test).

Find the assertion that reads the old field:
```ts
    expect(plan.accessToken).toBe('decrypted:tok');
```

Replace with:
```ts
    expect(plan.channelId).toBe('ch-1');
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/whatsapp/broadcast-core.test.ts src/lib/whatsapp/broadcast-resume.test.ts`
Expected: FAIL — `plan.channelId` is `undefined` and/or the source files still query `whatsapp_config`.

- [ ] **Step 4: Refactor `broadcast-core.ts`**

Update imports:

Find:
```ts
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
```

Replace with:
```ts
import {
  resolveChannelForSend,
  resolveProvider,
  ChannelResolutionError,
} from '@/lib/whatsapp/channel-resolution';
import type { WhatsAppProvider } from '@/lib/whatsapp/provider';
```

Update the `BroadcastPlan` interface:

Find:
```ts
export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}
```

Replace with:
```ts
export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  channelId: string;
  provider: WhatsAppProvider;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}
```

In `createBroadcast`, find:
```ts
  // Config (fail fast + provides the audit trail owner already resolved
  // by the caller). Meta send needs phone_number_id + decrypted token.
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();
  if (configError || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
  const accessToken = decrypt(config.access_token);
```

Replace with:
```ts
  // Resolve the channel this broadcast sends through. Broadcasts have
  // no conversation to pin a channel to, so this always resolves via
  // the account default (or the sole connected channel) — step 2/3 of
  // the routing rule, never step 1.
  let resolvedChannel;
  let provider;
  try {
    resolvedChannel = await resolveChannelForSend(db, accountId, null);
    provider = await resolveProvider(db, resolvedChannel);
  } catch (err) {
    if (err instanceof ChannelResolutionError) {
      throw new BroadcastError('whatsapp_not_configured', err.message, 400);
    }
    throw err;
  }
```

Find the `return` at the bottom of `createBroadcast`:
```ts
  return {
    broadcastId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phone_number_id,
    accessToken,
    templateRow,
    planned,
    rejected,
  };
```

Replace with:
```ts
  return {
    broadcastId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    channelId: resolvedChannel.channelId,
    provider,
    templateRow,
    planned,
    rejected,
  };
```

In `deliverBroadcast`, find:
```ts
        const result = await sendTemplateMessage({
          phoneNumberId: plan.phoneNumberId,
          accessToken: plan.accessToken,
          to: variant,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: recipient.params,
        });
```

Replace with:
```ts
        const result = await plan.provider.sendTemplate({
          to: variant,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: recipient.params,
        });
```

- [ ] **Step 5: Refactor `broadcast-resume.ts`**

Update imports:

Find:
```ts
import { BroadcastError, type BroadcastPlan } from '@/lib/whatsapp/broadcast-core';
import { decrypt } from '@/lib/whatsapp/encryption';
```

Replace with:
```ts
import { BroadcastError, type BroadcastPlan } from '@/lib/whatsapp/broadcast-core';
import {
  resolveChannelForSend,
  resolveProvider,
  ChannelResolutionError,
} from '@/lib/whatsapp/channel-resolution';
```

In `planBroadcastResume`, find:
```ts
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();
  if (configError || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
```

Replace with:
```ts
  let resolvedChannel;
  let provider;
  try {
    resolvedChannel = await resolveChannelForSend(db, accountId, null);
    provider = await resolveProvider(db, resolvedChannel);
  } catch (err) {
    if (err instanceof ChannelResolutionError) {
      throw new BroadcastError('whatsapp_not_configured', err.message, 400);
    }
    throw err;
  }
```

Find the `plan: BroadcastPlan` construction:
```ts
  const plan: BroadcastPlan = {
    broadcastId,
    templateName: broadcast.template_name,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
    templateRow: resolvedTemplate.row,
```

Replace with:
```ts
  const plan: BroadcastPlan = {
    broadcastId,
    templateName: broadcast.template_name,
    templateLanguage: resolvedTemplate.language,
    channelId: resolvedChannel.channelId,
    provider,
    templateRow: resolvedTemplate.row,
```

(The rest of the object — `planned`, `rejected` — is unchanged.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/whatsapp/broadcast-core.test.ts src/lib/whatsapp/broadcast-resume.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + full regression**

Run: `npm run typecheck`
Run: `npx vitest run`
Expected: no errors; same pass/fail counts as the Task 3 baseline.

- [ ] **Step 8: Commit**

```bash
git add src/lib/whatsapp/broadcast-core.ts src/lib/whatsapp/broadcast-core.test.ts src/lib/whatsapp/broadcast-resume.ts src/lib/whatsapp/broadcast-resume.test.ts
git commit -m "refactor(whatsapp): route broadcast-core.ts and broadcast-resume.ts through the channel-resolution layer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Refactor `src/lib/flows/meta-send.ts`

**Files:**
- Modify: `src/lib/flows/meta-send.ts`
- Create: `src/lib/flows/meta-send.test.ts`

**Interfaces:**
- Consumes: `resolveChannelForSend`, `resolveProvider`, `ChannelResolutionError` (from `@/lib/whatsapp/channel-resolution`, Task 2).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/flows/meta-send.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { engineSendText } from './meta-send'

const sendTextMessage = vi.fn(async () => ({ messageId: 'wamid.text' }))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: (...args: unknown[]) =>
    (sendTextMessage as unknown as (...a: unknown[]) => unknown)(...args),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))

let db: SupabaseClient
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => db,
}))

interface CapturedWrites {
  message?: Record<string, unknown>
}

function makeDb(opts: {
  channel?: Record<string, unknown> | null
  metaChannel?: Record<string, unknown> | null
  captured: CapturedWrites
}): SupabaseClient {
  const contact = { id: 'ct-1', phone: '+15551234567' }
  const conversation = { channel_id: null }
  return {
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') opts.captured.message = row
          return b
        },
        update: () => b,
        maybeSingle: async () => {
          if (table === 'contacts') return { data: contact, error: null }
          if (table === 'conversations') return { data: conversation, error: null }
          if (table === 'channels') return { data: opts.channel ?? null, error: null }
          return { data: null, error: null }
        },
        single: async () => {
          if (table === 'meta_channels') {
            return {
              data: opts.metaChannel ?? null,
              error: opts.metaChannel ? null : { message: 'not found' },
            }
          }
          return { data: null, error: null }
        },
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: [], error: null }),
      }
      return b
    },
  } as unknown as SupabaseClient
}

describe('engineSendText', () => {
  it('sends through the resolved channel provider and stamps channel_id on the persisted message', async () => {
    const captured: CapturedWrites = {}
    db = makeDb({
      channel: { id: 'ch-1', provider: 'meta' },
      metaChannel: { id: 'mc-1', phone_number_id: 'pn-1', access_token: 'tok' },
      captured,
    })

    const result = await engineSendText({
      accountId: 'acct-1',
      userId: 'u-1',
      conversationId: 'cv-1',
      contactId: 'ct-1',
      text: 'hello',
    })

    expect(result.whatsapp_message_id).toBe('wamid.text')
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pn-1',
        accessToken: 'tok',
        to: '15551234567',
        text: 'hello',
      })
    )
    expect(captured.message?.channel_id).toBe('ch-1')
  })

  it('throws when no channel is configured for the account', async () => {
    const captured: CapturedWrites = {}
    db = makeDb({ channel: null, metaChannel: null, captured })

    await expect(
      engineSendText({
        accountId: 'acct-1',
        userId: 'u-1',
        conversationId: 'cv-1',
        contactId: 'ct-1',
        text: 'hello',
      })
    ).rejects.toThrow('WhatsApp not configured for this account')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/flows/meta-send.test.ts`
Expected: FAIL — the source still queries `whatsapp_config` directly (table `'whatsapp_config'` isn't served by the new fake), and no `channel_id` is stamped.

- [ ] **Step 3: Refactor `meta-send.ts`**

Update imports at the top:

Find:
```ts
import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { decrypt } from '@/lib/whatsapp/encryption'
```

Replace with:
```ts
import {
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  resolveChannelForSend,
  resolveProvider,
  ChannelResolutionError,
} from '@/lib/whatsapp/channel-resolution'
```

In `engineSendText`, find:
```ts
  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: args.text,
    })
    return r.messageId
  }
```

Replace with:
```ts
  const { data: conversation } = await db
    .from('conversations')
    .select('channel_id')
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  let resolvedChannel
  let provider
  try {
    resolvedChannel = await resolveChannelForSend(
      db,
      args.accountId,
      conversation?.channel_id
    )
    provider = await resolveProvider(db, resolvedChannel)
  } catch (err) {
    if (err instanceof ChannelResolutionError) {
      throw new Error('WhatsApp not configured for this account')
    }
    throw err
  }

  const attempt = async (phone: string): Promise<string> => {
    const r = await provider.sendText({ to: phone, text: args.text })
    return r.messageId
  }
```

Further down in the same function, find the `messages` insert:
```ts
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: waMessageId,
    status: 'sent',
    ai_generated: args.aiGenerated ?? false,
  })
```

Replace with:
```ts
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: waMessageId,
    status: 'sent',
    ai_generated: args.aiGenerated ?? false,
    channel_id: resolvedChannel.channelId,
  })
```

In `engineSendMedia`, apply the identical pattern. Find:
```ts
  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendMediaMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    })
    return r.messageId
  }
```

Replace with:
```ts
  const { data: conversation } = await db
    .from('conversations')
    .select('channel_id')
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  let resolvedChannel
  let provider
  try {
    resolvedChannel = await resolveChannelForSend(
      db,
      args.accountId,
      conversation?.channel_id
    )
    provider = await resolveProvider(db, resolvedChannel)
  } catch (err) {
    if (err instanceof ChannelResolutionError) {
      throw new Error('WhatsApp not configured for this account')
    }
    throw err
  }

  const attempt = async (phone: string): Promise<string> => {
    const r = await provider.sendMedia({
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    })
    return r.messageId
  }
```

Find `engineSendMedia`'s `messages` insert:
```ts
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    message_id: waMessageId,
    status: 'sent',
  })
```

Replace with:
```ts
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    message_id: waMessageId,
    status: 'sent',
    channel_id: resolvedChannel.channelId,
  })
```

In `sendInteractiveViaMeta`, find:
```ts
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'buttons') {
      const r = await sendInteractiveButtons({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: input.bodyText,
        buttons: input.buttons,
        headerText: input.headerText,
        footerText: input.footerText,
      })
      return r.messageId
    }
    const r = await sendInteractiveList({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      bodyText: input.bodyText,
      buttonLabel: input.buttonLabel,
      sections: input.sections,
      headerText: input.headerText,
      footerText: input.footerText,
    })
    return r.messageId
  }
```

Replace with:
```ts
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: conversation } = await db
    .from('conversations')
    .select('channel_id')
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)
    .maybeSingle()

  let resolvedChannel
  let provider
  try {
    resolvedChannel = await resolveChannelForSend(
      db,
      input.accountId,
      conversation?.channel_id
    )
    provider = await resolveProvider(db, resolvedChannel)
  } catch (err) {
    if (err instanceof ChannelResolutionError) {
      throw new Error('WhatsApp not configured for this account')
    }
    throw err
  }

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'buttons') {
      const r = await provider.sendInteractiveButtons({
        to: phone,
        bodyText: input.bodyText,
        buttons: input.buttons,
        headerText: input.headerText,
        footerText: input.footerText,
      })
      return r.messageId
    }
    const r = await provider.sendInteractiveList({
      to: phone,
      bodyText: input.bodyText,
      buttonLabel: input.buttonLabel,
      sections: input.sections,
      headerText: input.headerText,
      footerText: input.footerText,
    })
    return r.messageId
  }
```

Find `sendInteractiveViaMeta`'s `messages` insert:
```ts
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: input.bodyText,
    interactive_payload: interactivePayload,
    message_id: waMessageId,
    status: 'sent',
  })
```

Replace with:
```ts
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: input.bodyText,
    interactive_payload: interactivePayload,
    message_id: waMessageId,
    status: 'sent',
    channel_id: resolvedChannel.channelId,
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/flows/meta-send.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + full regression**

Run: `npm run typecheck`
Run: `npx vitest run`
Expected: no errors; same pass/fail counts as the Task 4 baseline plus 2 new passing tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/flows/meta-send.ts src/lib/flows/meta-send.test.ts
git commit -m "refactor(flows): route meta-send.ts through the channel-resolution layer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Refactor `src/lib/automations/meta-send.ts`

**Files:**
- Modify: `src/lib/automations/meta-send.ts`
- Create: `src/lib/automations/meta-send.test.ts`

**Interfaces:**
- Consumes: `resolveChannelForSend`, `resolveProvider`, `ChannelResolutionError` (from `@/lib/whatsapp/channel-resolution`, Task 2).
- `engineSendInteractive` delegates to `flows/meta-send.ts`'s `engineSendInteractiveButtons`/`engineSendInteractiveList` (Task 5) — no change needed there, only `sendViaMeta` (the text/template path) is refactored.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/automations/meta-send.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { engineSendText, engineSendTemplate } from './meta-send'

const sendTextMessage = vi.fn(async () => ({ messageId: 'wamid.text' }))
const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.tpl' }))
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: (...args: unknown[]) =>
    (sendTextMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))

let db: SupabaseClient
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => db,
}))

interface CapturedWrites {
  message?: Record<string, unknown>
}

function makeDb(opts: {
  channel?: Record<string, unknown> | null
  metaChannel?: Record<string, unknown> | null
  templates?: Record<string, unknown>[]
  captured: CapturedWrites
}): SupabaseClient {
  const contact = { id: 'ct-1', phone: '+15551234567' }
  const conversation = { channel_id: null }
  return {
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') opts.captured.message = row
          return b
        },
        update: () => b,
        maybeSingle: async () => {
          if (table === 'contacts') return { data: contact, error: null }
          if (table === 'conversations') return { data: conversation, error: null }
          if (table === 'channels') return { data: opts.channel ?? null, error: null }
          return { data: null, error: null }
        },
        single: async () => {
          if (table === 'meta_channels') {
            return {
              data: opts.metaChannel ?? null,
              error: opts.metaChannel ? null : { message: 'not found' },
            }
          }
          return { data: null, error: null }
        },
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
          if (table === 'message_templates') {
            return resolve({ data: opts.templates ?? [], error: null })
          }
          return resolve({ data: [], error: null })
        },
      }
      return b
    },
  } as unknown as SupabaseClient
}

const FIXTURE = {
  channel: { id: 'ch-1', provider: 'meta' as const },
  metaChannel: { id: 'mc-1', phone_number_id: 'pn-1', access_token: 'tok' },
}

describe('engineSendText', () => {
  it('sends through the resolved channel provider and stamps channel_id', async () => {
    const captured: CapturedWrites = {}
    db = makeDb({ ...FIXTURE, captured })

    const result = await engineSendText({
      accountId: 'acct-1',
      userId: 'u-1',
      conversationId: 'cv-1',
      contactId: 'ct-1',
      text: 'hello',
    })

    expect(result.whatsapp_message_id).toBe('wamid.text')
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pn-1',
        accessToken: 'tok',
        to: '15551234567',
        text: 'hello',
      })
    )
    expect(captured.message?.channel_id).toBe('ch-1')
  })
})

describe('engineSendTemplate', () => {
  it('sends through the resolved channel provider and stamps channel_id', async () => {
    const captured: CapturedWrites = {}
    db = makeDb({ ...FIXTURE, captured })

    const result = await engineSendTemplate({
      accountId: 'acct-1',
      userId: 'u-1',
      conversationId: 'cv-1',
      contactId: 'ct-1',
      templateName: 'order_update',
      params: ['A123'],
    })

    expect(result.whatsapp_message_id).toBe('wamid.tpl')
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pn-1',
        accessToken: 'tok',
        to: '15551234567',
        templateName: 'order_update',
        params: ['A123'],
      })
    )
    expect(captured.message?.channel_id).toBe('ch-1')
  })

  it('throws when no channel is configured for the account', async () => {
    const captured: CapturedWrites = {}
    db = makeDb({ channel: null, metaChannel: null, captured })

    await expect(
      engineSendTemplate({
        accountId: 'acct-1',
        userId: 'u-1',
        conversationId: 'cv-1',
        contactId: 'ct-1',
        templateName: 'order_update',
      })
    ).rejects.toThrow('WhatsApp not configured for this account')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/automations/meta-send.test.ts`
Expected: FAIL — the source still queries `whatsapp_config`, and no `channel_id` is stamped.

- [ ] **Step 3: Refactor `meta-send.ts`**

Update imports at the top:

Find:
```ts
import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
```

Replace with:
```ts
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import {
  resolveChannelForSend,
  resolveProvider,
  ChannelResolutionError,
} from '@/lib/whatsapp/channel-resolution'
```

In `sendViaMeta`, find:
```ts
  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  // Local template row — read for the body we persist below, not for
  // the Meta payload (the wire shape is deliberately unchanged here).
  // A missing row is fine: the send still goes out, we just can't
  // reconstruct the text the customer saw.
  const templateRow =
    input.kind === 'template'
      ? (
          await resolveTemplateRow(
            db,
            input.accountId,
            input.templateName,
            input.language,
          )
        ).row
      : null

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        params: input.params,
      })
      return r.messageId
    }
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: input.text,
    })
    return r.messageId
  }
```

Replace with:
```ts
  const { data: conversation } = await db
    .from('conversations')
    .select('channel_id')
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)
    .maybeSingle()

  let resolvedChannel
  let provider
  try {
    resolvedChannel = await resolveChannelForSend(
      db,
      input.accountId,
      conversation?.channel_id
    )
    provider = await resolveProvider(db, resolvedChannel)
  } catch (err) {
    if (err instanceof ChannelResolutionError) {
      throw new Error('WhatsApp not configured for this account')
    }
    throw err
  }

  // Local template row — read for the body we persist below, not for
  // the Meta payload (the wire shape is deliberately unchanged here).
  // A missing row is fine: the send still goes out, we just can't
  // reconstruct the text the customer saw.
  const templateRow =
    input.kind === 'template'
      ? (
          await resolveTemplateRow(
            db,
            input.accountId,
            input.templateName,
            input.language,
          )
        ).row
      : null

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await provider.sendTemplate({
        to: phone,
        templateName: input.templateName,
        language: input.language,
        params: input.params,
      })
      return r.messageId
    }
    const r = await provider.sendText({ to: phone, text: input.text })
    return r.messageId
  }
```

Find the `messages` insert:
```ts
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type,
    content_text,
    template_name,
    message_id: waMessageId,
    status: 'sent',
  })
```

Replace with:
```ts
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type,
    content_text,
    template_name,
    message_id: waMessageId,
    status: 'sent',
    channel_id: resolvedChannel.channelId,
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/automations/meta-send.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + full regression**

Run: `npm run typecheck`
Run: `npx vitest run`
Expected: no errors; same pass/fail counts as the Task 5 baseline plus 3 new passing tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/automations/meta-send.ts src/lib/automations/meta-send.test.ts
git commit -m "refactor(automations): route meta-send.ts through the channel-resolution layer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Final regression + close out the plan

**Files:** none (verification + one doc edit)

- [ ] **Step 1: Confirm no call site still queries `whatsapp_config` for sending**

Run: `grep -rn "from('whatsapp_config')" src/lib/whatsapp/send-message.ts src/lib/whatsapp/broadcast-core.ts src/lib/whatsapp/broadcast-resume.ts src/lib/flows/meta-send.ts src/lib/automations/meta-send.ts`
Expected: no matches. (Settings-related routes — `src/app/api/whatsapp/config/*` — are explicitly out of scope for this plan and are expected to still reference `whatsapp_config`; the compat view keeps them working unchanged.)

- [ ] **Step 2: Full regression suite**

```bash
npm run typecheck
npx vitest run
```

Expected: identical pass/fail counts to `main`'s current baseline plus the new tests added across Tasks 1, 2, 5, 6 (meta-provider: 7, channel-resolution: 10, flows/meta-send: 2, automations/meta-send: 3 — 22 new passing tests), zero new failures. The 5 pre-existing unrelated failures (`src/lib/currency.test.ts` locale formatting, `src/lib/dashboard/date-utils.test.ts` timezone) are untouched by this plan.

- [ ] **Step 3: Manual smoke test (or SQL-level fallback)**

With the dev server running (`npm run dev`), sign in and:
- Send a text message from the Inbox composer to an existing conversation — confirm it delivers and the bubble appears as before.
- Send a broadcast to at least one recipient — confirm it delivers and the campaign detail page shows the recipient as sent.

If the dev server can't be reached in this environment (as in Plan 1's Task 6), fall back to confirming via SQL that a `messages` row inserted through the new path carries a non-null `channel_id` matching the account's `channels.is_default` row — e.g. `SELECT m.id, m.channel_id, c.provider FROM messages m JOIN channels c ON c.id = m.channel_id ORDER BY m.created_at DESC LIMIT 5;` — and note in the report which path was used.

- [ ] **Step 4: Update the design spec's status**

Edit `docs/superpowers/specs/2026-08-10-uazapi-provider-design.md`, changing:
```
Status: Plano 1 (schema) implementado
```
to:
```
Status: Plano 2 (camada de envio) implementado
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-10-uazapi-provider-design.md
git commit -m "docs: mark uazapi-provider spec Plano 2 (camada de envio) as implemented

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
