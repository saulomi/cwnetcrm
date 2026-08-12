# UAZAPI Provider Plan 4: send/receive implementation + Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make UAZAPI a real, connectable second WhatsApp provider — implement its send/receive HTTP layer, wire it into the channel-resolution/inbound-processor plumbing Plans 2-3 already built, and give Settings a channel-list UI (Meta form + new UAZAPI QR-connect flow) so an account can run a Meta number and a UAZAPI number side by side.

**Architecture:** `uazapi-api.ts` is a thin fetch wrapper over UAZAPI's REST endpoints (mirrors `meta-api.ts`'s shape exactly). `uazapi-provider.ts` adapts it to the existing `WhatsAppProvider` interface, the same way `meta-provider.ts` adapts `meta-api.ts`. `channel-resolution.ts`'s `resolveProvider` — which already throws `not_implemented` for `uazapi` channels (Plan 2) — gets that branch filled in. A new `/api/uazapi/webhook` route parses UAZAPI's inbound wire format into `NormalizedInboundMessage` and calls the same `inbound-processor.ts` Plan 3 built for Meta. Settings gets a `ChannelsList` component (new) that lists every `channels` row and renders the existing `WhatsAppConfig` form for the Meta card, or a new `UazapiChannelForm` (create instance → poll for QR → poll for connected) for UAZAPI cards. Two multi-channel gaps left over from Plans 2-3 — `/api/whatsapp/react` and `/api/whatsapp/broadcast` still querying `whatsapp_config` directly instead of going through channel-resolution — are closed as part of this plan.

**Tech Stack:** Next.js route handlers, Supabase (service-role + RLS), TypeScript, Vitest, `fetch`, next-intl (en/pt-BR/ko), React (`@base-ui/react` Dialog primitives already in the design system).

## Global Constraints

- **UAZAPI endpoint payloads are best-effort, not verified against a live instance.** Every assumption (URL paths, header names, request/response field names) is isolated inside `src/lib/whatsapp/uazapi-api.ts` and documented in that file's header comment. Every other file talks only to `uazapi-api.ts`'s typed functions or to `WhatsAppProvider`/`NormalizedInboundMessage` — never to raw UAZAPI JSON — so a future correction against a real instance is a single-file change.
- **Zero observable behavior change** for existing Meta-only, single-channel accounts, except the deliberate `channels.status` backfill-on-write this plan adds (dormant today since every such account's one channel is already `is_default=true`, so `resolveChannelForSend` never reaches the status-based fallback step).
- **`db`-as-first-parameter convention** for every new lib helper — matches Plan 2/3's established pattern, not the design spec's illustrative signatures.
- Tokens/secrets at rest use the existing `encryption.ts` (GCM, same `ENCRYPTION_KEY`) — `uazapi_channels.instance_token` and `uazapi_channels.webhook_secret` are both encrypted, matching `meta_channels.access_token`.
- No new migration — migration `039_whatsapp_channels.sql` (Plan 1) already created `channels` and `uazapi_channels` with every column this plan needs.
- Every user-facing string added to Settings goes into all three locale files: `messages/en.json`, `messages/pt-BR.json`, `messages/ko.json`.
- `npm run typecheck` and the full `npx vitest run` suite pass at every task boundary, using this codebase's established fake-Supabase-client mocking idiom (`vi.hoisted()` shared state, per-table `db.from(table)` switch dispatch, chainable/awaitable fakes).

---

## File Structure

- **Create** `src/lib/whatsapp/channel-status.ts` + test — write-through helper keeping `channels.status` in sync (currently only `meta_channels.status`/future `uazapi_channels` state get written).
- **Create** `src/lib/whatsapp/uazapi-api.ts` + test — raw UAZAPI REST wrapper (init/connect/status/send-text/send-media/send-menu/disconnect).
- **Create** `src/lib/whatsapp/uazapi-provider.ts` + test — `WhatsAppProvider` adapter over `uazapi-api.ts`.
- **Modify** `src/lib/whatsapp/channel-resolution.ts` + test — `resolveProvider` builds a real UAZAPI provider instead of throwing `not_implemented`.
- **Modify** `src/lib/whatsapp/resolve-conversation.ts` + test — fail-fast "is WhatsApp configured" pre-check queries `channels` (any provider) instead of `whatsapp_config` (Meta-only).
- **Modify** `src/app/api/whatsapp/config/route.ts` — POST/DELETE keep `channels.status` in sync via `channel-status.ts`.
- **Modify** `src/types/index.ts` — add `Channel` type.
- **Create** `src/app/api/channels/route.ts` + test — `GET` list channels for the account (merged with provider-specific detail).
- **Create** `src/app/api/channels/[id]/route.ts` + test — `PATCH` (label / set-default), `DELETE` (remove a channel, either provider).
- **Create** `src/app/api/uazapi/instance/route.ts` + test — `POST` create a UAZAPI instance (channel + `uazapi_channels` rows, initial QR).
- **Create** `src/app/api/uazapi/instance/[channelId]/route.ts` + test — `GET` poll connection status / refresh QR.
- **Create** `src/app/api/uazapi/webhook/route.ts` + test — inbound UAZAPI webhook → `inbound-processor.ts`.
- **Modify** `src/app/api/whatsapp/react/route.ts` + test (new) — resolve channel via `channel-resolution.ts` instead of a blind `whatsapp_config` lookup.
- **Modify** `src/app/api/whatsapp/broadcast/route.ts` + test (new) — resolve channel via `channel-resolution.ts`, send via `WhatsAppProvider.sendTemplate` instead of calling `meta-api.ts` directly; accepts optional `channel_id`.
- **Create** `src/components/settings/channels-list.tsx` — replaces the direct `<WhatsAppConfig />` render in Settings; lists channels, "Add channel" dialog (Meta → existing form; UAZAPI → new form).
- **Create** `src/components/settings/uazapi-channel-form.tsx` — label + base URL → create instance → QR → poll → connected.
- **Modify** `src/app/(dashboard)/settings/page.tsx` — swap `<WhatsAppConfig />` for `<ChannelsList />`.
- **Modify** `messages/en.json`, `messages/pt-BR.json`, `messages/ko.json` — new `Settings.whatsapp.channels.*` keys.
- **Modify** `docs/superpowers/specs/2026-08-10-uazapi-provider-design.md` — status line.

## Interfaces

Frozen for every task below — implementers see only their own task, so these are the only names/shapes neighboring tasks may assume exist.

```ts
// src/lib/whatsapp/channel-status.ts
export type ChannelStatus = 'connected' | 'disconnected' | 'connecting' | 'error'
export async function setChannelStatus(
  db: SupabaseClient,
  channelId: string,
  status: ChannelStatus,
): Promise<void>

// src/lib/whatsapp/uazapi-api.ts
export class UazapiApiError extends Error {}
export interface UazapiInstance { id: string; token: string }
export async function initUazapiInstance(args: { baseUrl: string; name: string }): Promise<UazapiInstance>
export interface UazapiConnectResult { status: string; qrCode?: string }
export async function connectUazapiInstance(args: { baseUrl: string; instanceToken: string }): Promise<UazapiConnectResult>
export interface UazapiStatusResult { status: 'connected' | 'connecting' | 'disconnected' | 'error'; phone?: string; profileName?: string }
export async function fetchUazapiInstanceStatus(args: { baseUrl: string; instanceToken: string }): Promise<UazapiStatusResult>
export interface UazapiSendResult { messageId: string }
export async function sendUazapiText(args: { baseUrl: string; instanceToken: string; to: string; text: string }): Promise<UazapiSendResult>
export async function sendUazapiMedia(args: { baseUrl: string; instanceToken: string; to: string; kind: 'image' | 'video' | 'document' | 'audio'; link: string; caption?: string }): Promise<UazapiSendResult>
export async function sendUazapiMenu(args: { baseUrl: string; instanceToken: string; to: string; text: string; choices: string[] }): Promise<UazapiSendResult>
export async function disconnectUazapiInstance(args: { baseUrl: string; instanceToken: string }): Promise<void>

// src/lib/whatsapp/uazapi-provider.ts
export interface UazapiProviderConfig { baseUrl: string; instanceToken: string }
export function createUazapiProvider(config: UazapiProviderConfig): WhatsAppProvider // from ./provider

// src/types/index.ts (addition)
export interface Channel {
  id: string;
  account_id: string;
  provider: 'meta' | 'uazapi';
  label: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  is_default: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

// GET /api/channels response
interface ChannelsListResponse {
  channels: Array<{
    id: string
    provider: 'meta' | 'uazapi'
    label: string
    status: 'connected' | 'disconnected' | 'connecting' | 'error'
    is_default: boolean
    meta?: { phone_number_id: string; waba_id: string | null; registered_at: string | null; last_registration_error: string | null }
    uazapi?: { instance_id: string; base_url: string; connected_phone: string | null; profile_name: string | null; last_error: string | null }
  }>
}

// POST /api/uazapi/instance
// body: { label: string; base_url: string }
// response: { channelId: string; qrCode: string | null }

// GET /api/uazapi/instance/[channelId]
// response: { status: 'connected' | 'connecting' | 'disconnected' | 'error'; qrCode?: string; phone?: string; profileName?: string; message?: string }
```

---

### Task 1: `channel-status.ts` — keep `channels.status` in sync

**Files:**
- Create: `src/lib/whatsapp/channel-status.ts`
- Test: `src/lib/whatsapp/channel-status.test.ts`

**Interfaces:**
- Produces: `setChannelStatus(db, channelId, status)` — see frozen Interfaces section above.

**Context:** `channels.status` has been sitting unwritten since migration 039 created it (Plan 1) — only `meta_channels.status` gets updated today. That's dormant because every existing account's one Meta channel is `is_default=true`, so `resolveChannelForSend` (`src/lib/whatsapp/channel-resolution.ts`) never reaches its "exactly one connected channel" fallback step, which is the only place `channels.status` is read. The moment an account has a second, non-default channel (this plan), that fallback becomes reachable and needs real data.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/whatsapp/channel-status.test.ts
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { setChannelStatus } from './channel-status'

function makeDb(updateError: { message: string } | null) {
  const calls: { table: string; patch: Record<string, unknown>; id: string }[] = []
  return {
    db: {
      from: (table: string) => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            calls.push({ table, patch, id })
            return Promise.resolve({ error: updateError })
          },
        }),
      }),
    } as unknown as SupabaseClient,
    calls,
  }
}

describe('setChannelStatus', () => {
  it('updates channels.status and updated_at for the given id', async () => {
    const { db, calls } = makeDb(null)
    await setChannelStatus(db, 'ch-1', 'connected')
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('channels')
    expect(calls[0].id).toBe('ch-1')
    expect(calls[0].patch).toMatchObject({ status: 'connected' })
    expect(typeof calls[0].patch.updated_at).toBe('string')
  })

  it('logs a warning but does not throw when the update fails', async () => {
    const { db } = makeDb({ message: 'boom' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(setChannelStatus(db, 'ch-1', 'error')).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/channel-status.test.ts`
Expected: FAIL — `Cannot find module './channel-status'`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/whatsapp/channel-status.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/channel-status.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/channel-status.ts src/lib/whatsapp/channel-status.test.ts
git commit -m "feat: add channel-status write-through helper"
```

---

### Task 2: `uazapi-api.ts` — raw UAZAPI REST wrapper

**Files:**
- Create: `src/lib/whatsapp/uazapi-api.ts`
- Test: `src/lib/whatsapp/uazapi-api.test.ts`

**Interfaces:**
- Produces: every function/type in the `uazapi-api.ts` block of the frozen Interfaces section above.

**Context:** Mirrors `src/lib/whatsapp/meta-api.ts`'s shape (one function per endpoint, throws a typed error on non-2xx, plain `fetch`). Read `meta-api.ts` lines 1-60 (imports/`throwMetaError`) and 218-260 (`sendTextMessage`) for the house style before writing this — same error-throwing pattern, same "assemble body, fetch, check `.ok`, parse JSON" shape.

**Endpoint assumptions — best-effort, not verified against a live UAZAPI instance** (per this plan's Global Constraints). Documented here so a future correction touches only this file:

- `POST {baseUrl}/instance/init` — body `{ name }`. No pre-existing auth (the instance doesn't exist yet); response assumed `{ instance: { id, token } }`, tolerant of a flat `{ id, token }` too.
- `POST {baseUrl}/instance/connect` — header `token: <instanceToken>`. Response assumed `{ instance: { status, qrcode } }` (qrcode a base64 PNG, with or without a `data:image/png;base64,` prefix), tolerant of a flat `{ status, qrcode }`.
- `GET {baseUrl}/instance/status` — header `token: <instanceToken>`. Response assumed `{ instance: { status, owner, profileName } }` (`owner` = connected phone number), tolerant of a flat shape.
- `POST {baseUrl}/send/text` — header `token`, body `{ number, text }`. Response assumed `{ id }`, falling back to `{ messageid }`.
- `POST {baseUrl}/send/media` — header `token`, body `{ number, type, file, caption? }` (`file` = a public URL). Response same id fallback chain.
- `POST {baseUrl}/send/menu` — header `token`, body `{ number, type: 'button', text, choices }` (`choices`: string array — UAZAPI's public "menu" endpoint collapses button id and title into one string; there's no way to preserve a separate stable id without a live instance to confirm against, so `sendInteractiveButtons`/`sendInteractiveList` on the UAZAPI provider (Task 3) use the button/row *title* as the choice). Response same id fallback chain.
- `DELETE {baseUrl}/instance` — header `token`. No response body expected.
- Phone numbers are sent as bare digits (no `+`, no formatting) — UAZAPI's documented convention for `number`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/whatsapp/uazapi-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  UazapiApiError,
  initUazapiInstance,
  connectUazapiInstance,
  fetchUazapiInstanceStatus,
  sendUazapiText,
  sendUazapiMedia,
  sendUazapiMenu,
  disconnectUazapiInstance,
} from './uazapi-api'

const BASE = 'https://demo.uazapi.example'
const TOKEN = 'inst-token-1'

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

describe('initUazapiInstance', () => {
  it('POSTs /instance/init and returns id + token', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ instance: { id: 'inst-1', token: TOKEN } })
    )
    const result = await initUazapiInstance({ baseUrl: BASE, name: 'Sales' })
    expect(result).toEqual({ id: 'inst-1', token: TOKEN })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`${BASE}/instance/init`)
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'Sales' })
  })

  it('throws UazapiApiError on a non-2xx response', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ error: 'bad request' }, false, 400)
    )
    await expect(initUazapiInstance({ baseUrl: BASE, name: 'Sales' })).rejects.toBeInstanceOf(
      UazapiApiError
    )
  })
})

describe('connectUazapiInstance', () => {
  it('sends the instance token header and returns status + qrCode', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ instance: { status: 'connecting', qrcode: 'base64QR' } })
    )
    const result = await connectUazapiInstance({ baseUrl: BASE, instanceToken: TOKEN })
    expect(result).toEqual({ status: 'connecting', qrCode: 'base64QR' })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`${BASE}/instance/connect`)
    expect((init as RequestInit & { headers: Record<string, string> }).headers.token).toBe(TOKEN)
  })
})

describe('fetchUazapiInstanceStatus', () => {
  it('maps a connected instance', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ instance: { status: 'connected', owner: '5511999998888', profileName: 'Ada' } })
    )
    const result = await fetchUazapiInstanceStatus({ baseUrl: BASE, instanceToken: TOKEN })
    expect(result).toEqual({ status: 'connected', phone: '5511999998888', profileName: 'Ada' })
  })
})

describe('sendUazapiText', () => {
  it('POSTs /send/text with number + text and returns the message id', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ id: 'uaz-msg-1' }))
    const result = await sendUazapiText({ baseUrl: BASE, instanceToken: TOKEN, to: '+55 11 99999-8888', text: 'oi' })
    expect(result).toEqual({ messageId: 'uaz-msg-1' })
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      number: '5511999998888',
      text: 'oi',
    })
  })

  it('falls back to messageid when id is absent', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ messageid: 'uaz-msg-2' }))
    const result = await sendUazapiText({ baseUrl: BASE, instanceToken: TOKEN, to: '5511999998888', text: 'oi' })
    expect(result).toEqual({ messageId: 'uaz-msg-2' })
  })
})

describe('sendUazapiMedia', () => {
  it('POSTs /send/media with the mapped kind and file link', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ id: 'uaz-msg-3' }))
    await sendUazapiMedia({
      baseUrl: BASE,
      instanceToken: TOKEN,
      to: '5511999998888',
      kind: 'image',
      link: 'https://x/y.jpg',
      caption: 'cap',
    })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`${BASE}/send/media`)
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      number: '5511999998888',
      type: 'image',
      file: 'https://x/y.jpg',
      caption: 'cap',
    })
  })
})

describe('sendUazapiMenu', () => {
  it('POSTs /send/menu with the choices array', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ id: 'uaz-msg-4' }))
    await sendUazapiMenu({
      baseUrl: BASE,
      instanceToken: TOKEN,
      to: '5511999998888',
      text: 'Pick one',
      choices: ['Yes', 'No'],
    })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`${BASE}/send/menu`)
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      number: '5511999998888',
      type: 'button',
      text: 'Pick one',
      choices: ['Yes', 'No'],
    })
  })
})

describe('disconnectUazapiInstance', () => {
  it('DELETEs /instance with the token header', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({}))
    await disconnectUazapiInstance({ baseUrl: BASE, instanceToken: TOKEN })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe(`${BASE}/instance`)
    expect((init as RequestInit).method).toBe('DELETE')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/uazapi-api.test.ts`
Expected: FAIL — `Cannot find module './uazapi-api'`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/whatsapp/uazapi-api.ts
// ============================================================
// Raw UAZAPI REST wrapper — mirrors meta-api.ts's shape (one function
// per endpoint, throws UazapiApiError on non-2xx, plain fetch).
//
// ENDPOINT SHAPES ARE BEST-EFFORT, NOT VERIFIED AGAINST A LIVE
// INSTANCE — see docs/superpowers/plans/2026-08-12-uazapi-provider-
// plan-4-provider-ui.md, Task 2, for the exact assumptions and why.
// Every other module in this codebase talks only to the typed
// functions below, never to raw UAZAPI JSON, so correcting a payload
// shape against a real instance later is a single-file change.
// ============================================================

export class UazapiApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'UazapiApiError'
    this.status = status
  }
}

async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let detail = fallback
  try {
    const body = await response.json()
    detail = body?.error || body?.message || fallback
  } catch {
    // Non-JSON error body — keep the fallback message.
  }
  throw new UazapiApiError(detail, response.status)
}

/** UAZAPI's documented `number` format — bare digits, no `+`/formatting. */
function toUazapiNumber(phone: string): string {
  return phone.replace(/\D/g, '')
}

function authHeaders(instanceToken: string): Record<string, string> {
  return { 'Content-Type': 'application/json', token: instanceToken }
}

export interface UazapiInstance {
  id: string
  token: string
}

/**
 * Provision a brand-new instance on a UAZAPI server. Unauthenticated —
 * the instance (and its token) don't exist yet; the returned token
 * becomes this instance's own secret for every subsequent call.
 */
export async function initUazapiInstance(args: {
  baseUrl: string
  name: string
}): Promise<UazapiInstance> {
  const { baseUrl, name } = args
  const response = await fetch(`${baseUrl}/instance/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI init failed: ${response.status}`)
  }
  const data = await response.json()
  const instance = data.instance ?? data
  return { id: instance.id, token: instance.token }
}

export interface UazapiConnectResult {
  status: string
  qrCode?: string
}

/** Trigger the QR-code handshake for an existing instance. */
export async function connectUazapiInstance(args: {
  baseUrl: string
  instanceToken: string
}): Promise<UazapiConnectResult> {
  const { baseUrl, instanceToken } = args
  const response = await fetch(`${baseUrl}/instance/connect`, {
    method: 'POST',
    headers: authHeaders(instanceToken),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI connect failed: ${response.status}`)
  }
  const data = await response.json()
  const instance = data.instance ?? data
  return { status: instance.status, qrCode: instance.qrcode ?? undefined }
}

export interface UazapiStatusResult {
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  phone?: string
  profileName?: string
}

function normalizeUazapiStatus(raw: unknown): UazapiStatusResult['status'] {
  const s = String(raw ?? '').toLowerCase()
  if (s === 'connected' || s === 'open') return 'connected'
  if (s === 'connecting' || s === 'qrcode' || s === 'qr') return 'connecting'
  if (s === 'error' || s === 'failed') return 'error'
  return 'disconnected'
}

export async function fetchUazapiInstanceStatus(args: {
  baseUrl: string
  instanceToken: string
}): Promise<UazapiStatusResult> {
  const { baseUrl, instanceToken } = args
  const response = await fetch(`${baseUrl}/instance/status`, {
    method: 'GET',
    headers: authHeaders(instanceToken),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI status check failed: ${response.status}`)
  }
  const data = await response.json()
  const instance = data.instance ?? data
  return {
    status: normalizeUazapiStatus(instance.status),
    phone: instance.owner ?? undefined,
    profileName: instance.profileName ?? undefined,
  }
}

export interface UazapiSendResult {
  messageId: string
}

function extractMessageId(data: Record<string, unknown>): string {
  return String(data.id ?? data.messageid ?? '')
}

export async function sendUazapiText(args: {
  baseUrl: string
  instanceToken: string
  to: string
  text: string
}): Promise<UazapiSendResult> {
  const { baseUrl, instanceToken, to, text } = args
  const response = await fetch(`${baseUrl}/send/text`, {
    method: 'POST',
    headers: authHeaders(instanceToken),
    body: JSON.stringify({ number: toUazapiNumber(to), text }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI send/text failed: ${response.status}`)
  }
  return { messageId: extractMessageId(await response.json()) }
}

export async function sendUazapiMedia(args: {
  baseUrl: string
  instanceToken: string
  to: string
  kind: 'image' | 'video' | 'document' | 'audio'
  link: string
  caption?: string
}): Promise<UazapiSendResult> {
  const { baseUrl, instanceToken, to, kind, link, caption } = args
  const body: Record<string, unknown> = { number: toUazapiNumber(to), type: kind, file: link }
  if (caption) body.caption = caption
  const response = await fetch(`${baseUrl}/send/media`, {
    method: 'POST',
    headers: authHeaders(instanceToken),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI send/media failed: ${response.status}`)
  }
  return { messageId: extractMessageId(await response.json()) }
}

export async function sendUazapiMenu(args: {
  baseUrl: string
  instanceToken: string
  to: string
  text: string
  choices: string[]
}): Promise<UazapiSendResult> {
  const { baseUrl, instanceToken, to, text, choices } = args
  const response = await fetch(`${baseUrl}/send/menu`, {
    method: 'POST',
    headers: authHeaders(instanceToken),
    body: JSON.stringify({ number: toUazapiNumber(to), type: 'button', text, choices }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI send/menu failed: ${response.status}`)
  }
  return { messageId: extractMessageId(await response.json()) }
}

export async function disconnectUazapiInstance(args: {
  baseUrl: string
  instanceToken: string
}): Promise<void> {
  const { baseUrl, instanceToken } = args
  const response = await fetch(`${baseUrl}/instance`, {
    method: 'DELETE',
    headers: authHeaders(instanceToken),
  })
  if (!response.ok) {
    await throwUazapiError(response, `UAZAPI disconnect failed: ${response.status}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/uazapi-api.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/uazapi-api.ts src/lib/whatsapp/uazapi-api.test.ts
git commit -m "feat: add UAZAPI REST wrapper (best-effort endpoint shapes)"
```

---

### Task 3: `uazapi-provider.ts` — `WhatsAppProvider` adapter

**Files:**
- Create: `src/lib/whatsapp/uazapi-provider.ts`
- Test: `src/lib/whatsapp/uazapi-provider.test.ts`

**Interfaces:**
- Consumes: everything from `uazapi-api.ts` (Task 2), `WhatsAppProvider`/`SendTextArgs`/`SendMediaArgs`/`SendTemplateArgs`/`SendInteractiveButtonsArgs`/`SendInteractiveListArgs`/`ProviderSendResult`/`ConnectionInfo` from `./provider` (existing, Plan 2), `renderTemplateBody` from `./template-body` (existing).
- Produces: `createUazapiProvider(config)` — see frozen Interfaces section.

**Context:** Read `src/lib/whatsapp/meta-provider.ts` first — same adapter shape (bind config once, every method is a thin pass-through). `sendTemplate` is the one method with real logic: UAZAPI has no template-approval system, so the template row is rendered to plain text/media/buttons at send time (per the design spec's "Camada de envio" section). `renderTemplateBody(body, params)` (from `./template-body`, already used by `templateContentText`) substitutes `{{1}}`, `{{2}}`… — that's the rendering primitive to reuse.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/whatsapp/uazapi-provider.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createUazapiProvider } from './uazapi-provider'
import type { MessageTemplate } from '@/types'

const sendUazapiText = vi.fn(async () => ({ messageId: 'uaz-text' }))
const sendUazapiMedia = vi.fn(async () => ({ messageId: 'uaz-media' }))
const sendUazapiMenu = vi.fn(async () => ({ messageId: 'uaz-menu' }))
const fetchUazapiInstanceStatus = vi.fn(async () => ({ status: 'connected' as const, phone: '5511999998888' }))

vi.mock('./uazapi-api', () => ({
  sendUazapiText: (...args: unknown[]) => (sendUazapiText as unknown as (...a: unknown[]) => unknown)(...args),
  sendUazapiMedia: (...args: unknown[]) => (sendUazapiMedia as unknown as (...a: unknown[]) => unknown)(...args),
  sendUazapiMenu: (...args: unknown[]) => (sendUazapiMenu as unknown as (...a: unknown[]) => unknown)(...args),
  fetchUazapiInstanceStatus: (...args: unknown[]) =>
    (fetchUazapiInstanceStatus as unknown as (...a: unknown[]) => unknown)(...args),
}))

const CONFIG = { baseUrl: 'https://demo.uazapi.example', instanceToken: 'tok-1' }

describe('createUazapiProvider', () => {
  it('sendText forwards to sendUazapiText', async () => {
    const provider = createUazapiProvider(CONFIG)
    const result = await provider.sendText({ to: '+5511999998888', text: 'hi' })
    expect(result).toEqual({ messageId: 'uaz-text' })
    expect(sendUazapiText).toHaveBeenCalledWith({
      baseUrl: CONFIG.baseUrl,
      instanceToken: CONFIG.instanceToken,
      to: '+5511999998888',
      text: 'hi',
    })
  })

  it('sendMedia forwards to sendUazapiMedia', async () => {
    const provider = createUazapiProvider(CONFIG)
    await provider.sendMedia({ to: '+5511999998888', kind: 'image', link: 'https://x/y.jpg', caption: 'cap' })
    expect(sendUazapiMedia).toHaveBeenCalledWith({
      baseUrl: CONFIG.baseUrl,
      instanceToken: CONFIG.instanceToken,
      to: '+5511999998888',
      kind: 'image',
      link: 'https://x/y.jpg',
      caption: 'cap',
    })
  })

  it('sendInteractiveButtons maps button titles to menu choices', async () => {
    const provider = createUazapiProvider(CONFIG)
    await provider.sendInteractiveButtons({
      to: '+5511999998888',
      bodyText: 'Pick one',
      buttons: [{ id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }],
    })
    expect(sendUazapiMenu).toHaveBeenCalledWith({
      baseUrl: CONFIG.baseUrl,
      instanceToken: CONFIG.instanceToken,
      to: '+5511999998888',
      text: 'Pick one',
      choices: ['Yes', 'No'],
    })
  })

  it('sendInteractiveList flattens every section row into one choice list', async () => {
    const provider = createUazapiProvider(CONFIG)
    await provider.sendInteractiveList({
      to: '+5511999998888',
      bodyText: 'Choose',
      buttonLabel: 'Open',
      sections: [
        { title: 'A', rows: [{ id: '1', title: 'One' }] },
        { title: 'B', rows: [{ id: '2', title: 'Two' }] },
      ],
    })
    expect(sendUazapiMenu).toHaveBeenCalledWith({
      baseUrl: CONFIG.baseUrl,
      instanceToken: CONFIG.instanceToken,
      to: '+5511999998888',
      text: 'Choose',
      choices: ['One', 'Two'],
    })
  })

  it('verifyConnection maps a connected instance', async () => {
    const provider = createUazapiProvider(CONFIG)
    const result = await provider.verifyConnection()
    expect(result).toEqual({ connected: true, detail: 'connected' })
  })

  describe('sendTemplate', () => {
    const template: MessageTemplate = {
      id: 't1',
      user_id: 'u1',
      name: 'promo',
      category: 'Marketing',
      body_text: 'Hi {{1}}, {{2}} is on sale',
      buttons: [{ type: 'QUICK_REPLY', text: 'Interested' }],
      created_at: '2026-01-01T00:00:00Z',
    }

    it('sends via the menu endpoint when the template has quick-reply buttons', async () => {
      const provider = createUazapiProvider(CONFIG)
      await provider.sendTemplate({
        to: '+5511999998888',
        templateName: 'promo',
        template,
        messageParams: { body: ['Ada', 'the widget'] },
      })
      expect(sendUazapiMenu).toHaveBeenCalledWith({
        baseUrl: CONFIG.baseUrl,
        instanceToken: CONFIG.instanceToken,
        to: '+5511999998888',
        text: 'Hi Ada, the widget is on sale',
        choices: ['Interested'],
      })
    })

    it('sends via the media endpoint when the template has a media header and no buttons', async () => {
      const provider = createUazapiProvider(CONFIG)
      const mediaTemplate: MessageTemplate = {
        ...template,
        buttons: undefined,
        header_type: 'image',
        header_media_url: 'https://x/banner.jpg',
      }
      await provider.sendTemplate({
        to: '+5511999998888',
        templateName: 'promo',
        template: mediaTemplate,
        messageParams: { body: ['Ada', 'the widget'] },
      })
      expect(sendUazapiMedia).toHaveBeenCalledWith({
        baseUrl: CONFIG.baseUrl,
        instanceToken: CONFIG.instanceToken,
        to: '+5511999998888',
        kind: 'image',
        link: 'https://x/banner.jpg',
        caption: 'Hi Ada, the widget is on sale',
      })
    })

    it('falls back to plain text when there is no media header and no buttons', async () => {
      const provider = createUazapiProvider(CONFIG)
      const textTemplate: MessageTemplate = { ...template, buttons: undefined }
      await provider.sendTemplate({
        to: '+5511999998888',
        templateName: 'promo',
        template: textTemplate,
        messageParams: { body: ['Ada', 'the widget'] },
      })
      expect(sendUazapiText).toHaveBeenCalledWith({
        baseUrl: CONFIG.baseUrl,
        instanceToken: CONFIG.instanceToken,
        to: '+5511999998888',
        text: 'Hi Ada, the widget is on sale',
      })
    })

    it('falls back to legacy params + templateName when no template row is available', async () => {
      const provider = createUazapiProvider(CONFIG)
      await provider.sendTemplate({ to: '+5511999998888', templateName: 'promo', params: ['Ada'] })
      expect(sendUazapiText).toHaveBeenCalledWith({
        baseUrl: CONFIG.baseUrl,
        instanceToken: CONFIG.instanceToken,
        to: '+5511999998888',
        text: 'Ada',
      })
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/uazapi-provider.test.ts`
Expected: FAIL — `Cannot find module './uazapi-provider'`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/whatsapp/uazapi-provider.ts
import {
  sendUazapiText,
  sendUazapiMedia,
  sendUazapiMenu,
  fetchUazapiInstanceStatus,
} from './uazapi-api'
import { renderTemplateBody } from './template-body'
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

export interface UazapiProviderConfig {
  baseUrl: string
  instanceToken: string
}

/**
 * Adapts uazapi-api.ts's free functions to the shared WhatsAppProvider
 * interface — the UAZAPI counterpart to meta-provider.ts.
 *
 * sendTemplate is the one method with real logic: UAZAPI has no
 * template-approval system (per the design spec's "Camada de envio"),
 * so the local `message_templates` row is rendered to a plain send at
 * call time instead of referencing an approved template by name:
 *   - Quick-reply buttons present  → sendInteractiveButtons (menu).
 *   - No buttons, media header set → sendMedia, caption = rendered body.
 *   - Otherwise                    → sendText with the rendered body.
 * URL/COPY_CODE/PHONE_NUMBER buttons have no UAZAPI menu equivalent
 * confirmed without a live instance — they're silently dropped from
 * the send (documented parity gap; the rendered body text still goes
 * out either way).
 */
export function createUazapiProvider(config: UazapiProviderConfig): WhatsAppProvider {
  const { baseUrl, instanceToken } = config

  return {
    async sendText(args: SendTextArgs): Promise<ProviderSendResult> {
      const result = await sendUazapiText({ baseUrl, instanceToken, to: args.to, text: args.text })
      return { messageId: result.messageId }
    },

    async sendMedia(args: SendMediaArgs): Promise<ProviderSendResult> {
      const result = await sendUazapiMedia({
        baseUrl,
        instanceToken,
        to: args.to,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
      })
      return { messageId: result.messageId }
    },

    async sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult> {
      const { to, template, messageParams, params, templateName } = args
      const bodyValues = messageParams?.body ?? params ?? []
      const text = template?.body_text
        ? renderTemplateBody(template.body_text, bodyValues)
        : bodyValues.join(' ') || templateName

      const quickReplyButtons = (template?.buttons ?? []).filter((b) => b.type === 'QUICK_REPLY')
      if (quickReplyButtons.length > 0) {
        const result = await sendUazapiMenu({
          baseUrl,
          instanceToken,
          to,
          text,
          choices: quickReplyButtons.map((b) => b.text),
        })
        return { messageId: result.messageId }
      }

      const mediaLink = messageParams?.headerMediaUrl ?? template?.header_media_url
      if (template?.header_type && template.header_type !== 'text' && mediaLink) {
        const result = await sendUazapiMedia({
          baseUrl,
          instanceToken,
          to,
          kind: template.header_type,
          link: mediaLink,
          caption: text,
        })
        return { messageId: result.messageId }
      }

      const result = await sendUazapiText({ baseUrl, instanceToken, to, text })
      return { messageId: result.messageId }
    },

    async sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<ProviderSendResult> {
      const result = await sendUazapiMenu({
        baseUrl,
        instanceToken,
        to: args.to,
        text: args.bodyText,
        choices: args.buttons.map((b) => b.title),
      })
      return { messageId: result.messageId }
    },

    async sendInteractiveList(args: SendInteractiveListArgs): Promise<ProviderSendResult> {
      const choices = args.sections.flatMap((section) => section.rows).map((row) => row.title)
      const result = await sendUazapiMenu({
        baseUrl,
        instanceToken,
        to: args.to,
        text: args.bodyText,
        choices,
      })
      return { messageId: result.messageId }
    },

    async verifyConnection(): Promise<ConnectionInfo> {
      try {
        const status = await fetchUazapiInstanceStatus({ baseUrl, instanceToken })
        return { connected: status.status === 'connected', detail: status.status }
      } catch (err) {
        return { connected: false, detail: err instanceof Error ? err.message : 'Unknown error' }
      }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/uazapi-provider.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/uazapi-provider.ts src/lib/whatsapp/uazapi-provider.test.ts
git commit -m "feat: add UAZAPI WhatsAppProvider adapter"
```

---

### Task 4: Wire `resolveProvider` to UAZAPI

**Files:**
- Modify: `src/lib/whatsapp/channel-resolution.ts:98-146`
- Modify: `src/lib/whatsapp/channel-resolution.test.ts`

**Interfaces:**
- Consumes: `createUazapiProvider` from `./uazapi-provider` (Task 3).

**Context:** Read the full current `channel-resolution.ts` — `resolveProvider` currently throws `ChannelResolutionError('not_implemented', ...)` for `channel.provider === 'uazapi'` at the top of the function. Replace that branch with a real lookup + provider build, mirroring the existing Meta branch below it exactly (same error-on-missing-row handling, same `decrypt`).

- [ ] **Step 1: Write the failing test**

Add to the end of `src/lib/whatsapp/channel-resolution.test.ts` (read the existing file first for its `makeDb`/mock conventions and match them):

```ts
describe('resolveProvider — uazapi', () => {
  it('builds a UazapiProvider from the decrypted instance token', async () => {
    const db = {
      from: (table: string) => {
        if (table === 'uazapi_channels') {
          return {
            select: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: {
                      id: 'uaz-1',
                      channel_id: 'ch-2',
                      base_url: 'https://demo.uazapi.example',
                      instance_token: 'plain-instance-token',
                    },
                    error: null,
                  }),
              }),
            }),
          }
        }
        throw new Error(`unexpected table: ${table}`)
      },
    } as unknown as SupabaseClient

    const provider = await resolveProvider(db, { channelId: 'ch-2', provider: 'uazapi' })
    expect(provider).toBeTruthy()
    expect(typeof provider.sendText).toBe('function')
  })

  it('throws not_configured when the uazapi_channels row is missing', async () => {
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'no rows' } }) }) }),
      }),
    } as unknown as SupabaseClient

    await expect(resolveProvider(db, { channelId: 'ch-3', provider: 'uazapi' })).rejects.toMatchObject({
      code: 'not_configured',
    })
  })
})
```

(This assumes `encryption.ts`'s `decrypt` is already mocked in this test file the way `meta-provider.test.ts`/`channel-resolution.test.ts` mock it today — reuse whatever mock is already at the top of the file rather than adding a second one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/channel-resolution.test.ts`
Expected: FAIL — the `not_implemented` branch throws instead of returning a provider.

- [ ] **Step 3: Write the implementation**

In `src/lib/whatsapp/channel-resolution.ts`, add the import and replace the `resolveProvider` body:

```ts
import { createUazapiProvider } from './uazapi-provider'
```

```ts
export async function resolveProvider(
  db: SupabaseClient,
  channel: ResolvedChannel
): Promise<WhatsAppProvider> {
  if (channel.provider === 'uazapi') {
    const { data: uazapiChannel, error } = await db
      .from('uazapi_channels')
      .select('*')
      .eq('channel_id', channel.channelId)
      .single()
    if (error || !uazapiChannel) {
      throw new ChannelResolutionError(
        'not_configured',
        'UAZAPI channel not configured. Please finish connecting it in Settings.'
      )
    }
    return createUazapiProvider({
      baseUrl: uazapiChannel.base_url,
      instanceToken: decrypt(uazapiChannel.instance_token),
    })
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

Also update the doc comment directly above `resolveProvider` (currently says "UAZAPI channels are schema-valid ... but have no send-side implementation until a later plan") — remove the now-inaccurate "no send-side implementation" sentence since this task adds it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/channel-resolution.test.ts`
Expected: PASS (all existing tests + the 2 new ones)

- [ ] **Step 5: Run the broader suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS — `broadcast-core.ts` already calls `resolveProvider` (Plan 2), so this is the first point that code path can actually reach a UAZAPI send.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/channel-resolution.ts src/lib/whatsapp/channel-resolution.test.ts
git commit -m "feat: wire resolveProvider to build a real UAZAPI provider"
```

---

### Task 5: Fix `resolve-conversation.ts`'s Meta-only pre-check

**Files:**
- Modify: `src/lib/whatsapp/resolve-conversation.ts:56-69`
- Modify: `src/lib/whatsapp/resolve-conversation.test.ts`

**Context:** `resolveConversationByPhone`'s fail-fast "is WhatsApp configured at all" check currently queries `whatsapp_config` (the Meta-only compatibility view) — an account with only a connected UAZAPI channel and no Meta channel would incorrectly get "WhatsApp not configured" here even though it has a working channel. This is a distinct query from the one a few lines later inside `resolveAuditUserId` (`src/lib/api/v1/contacts.ts:77-83`), which also reads `whatsapp_config` for a different reason (finding an owner `user_id` to attribute created rows to) and has its own fallback to `accounts.owner_user_id` — **do not touch that one**, only the existence pre-check in `resolve-conversation.ts`.

- [ ] **Step 1: Write the failing test**

Read `src/lib/whatsapp/resolve-conversation.test.ts` in full first — the `makeDb`/`Script` shape is reused below verbatim except for the additions.

Modify the `Script` interface (add one field, keep everything else):

```ts
interface Script {
  config?: { user_id: string } | null; // whatsapp_config.maybeSingle (resolveAuditUserId — unrelated to hasChannel)
  hasChannel?: boolean; // channels .eq(account_id).limit(1) — the "is anything connected" pre-check
  contactCandidates?: ContactRow[]; // contacts .like (same every call)
  // ...rest unchanged
```

Modify the `limit` handler in `makeDb` to add a `channels` branch alongside the existing `conversations` one:

```ts
    limit: () => {
      // Only the conversation lookup and the channels pre-check
      // terminate on `.limit(1)`.
      if (table === 'conversations' && mode === 'select') {
        const row = script.existingConversationByCall
          ? (script.existingConversationByCall[convLookupCalls] ?? null)
          : (script.existingConversation ?? null);
        convLookupCalls++;
        return Promise.resolve({ data: row ? [row] : [], error: null });
      }
      if (table === 'channels' && mode === 'select') {
        return Promise.resolve({ data: script.hasChannel ? [{ id: 'ch-1' }] : [], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    },
```

Update every existing test call site: the one that currently reads `config: null` (the "not configured" test, around line 125) becomes `hasChannel: false` (drop the now-irrelevant `config: null` — that field only matters when `hasChannel` is true, since `resolveAuditUserId` is never reached on the not-configured path). The four call sites currently reading `config: { user_id: 'owner-1' }` (the happy-path tests) become `{ hasChannel: true, config: { user_id: 'owner-1' }, ...rest unchanged }` — both fields are needed now, since `hasChannel` gates the new pre-check and `config` still feeds `resolveAuditUserId`'s owner lookup.

Add one new test confirming a UAZAPI-only account (no `whatsapp_config`/Meta row at all, but a `channels` row) passes the pre-check:

```ts
it('does not require a Meta config row when a non-Meta channel exists', async () => {
  const db = makeDb({
    hasChannel: true,
    config: null, // no Meta row — resolveAuditUserId falls back to accounts.owner_user_id, which this fake returns null for by default
    contactCandidates: [{ id: 'contact-1', phone: '+15551234567' }],
    existingConversation: { id: 'conv-1' },
  });
  // resolveAuditUserId's fallback to `accounts.owner_user_id` also resolves
  // through this same generic builder — its default branch returns
  // { data: null, error: null }, so this test only needs to prove the
  // channels pre-check itself no longer throws "not configured". If the
  // account-owner fallback throws in this fake, wire config.user_id
  // instead: makeDb({ hasChannel: true, config: { user_id: 'owner-1' }, ... }).
  await expect(
    resolveConversationByPhone(db, 'acc-1', '+15551234567')
  ).resolves.toMatchObject({ conversationId: 'conv-1', contactId: 'contact-1' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/resolve-conversation.test.ts`
Expected: FAIL — current code still queries `whatsapp_config` for the pre-check, ignoring `script.hasChannel`, so the new test either throws "not configured" (if `config: null` is read by the old code path) or the existing tests break because the `Script` shape changed.

- [ ] **Step 3: Write the implementation**

In `src/lib/whatsapp/resolve-conversation.ts`, replace:

```ts
  // Fail fast (and create nothing) when the account has no WhatsApp
  // connected — the same error the send would raise anyway.
  const { data: config } = await db
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .maybeSingle();
  if (!config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
```

with:

```ts
  // Fail fast (and create nothing) when the account has no WhatsApp
  // channel connected at all — any provider. Bare `.eq(account_id)` +
  // `.maybeSingle()` would throw once an account has 2+ channels
  // (the whole point of this plan), so this checks existence via
  // `.limit(1)` + array-length rather than assuming at most one row.
  const { data: anyChannel } = await db
    .from('channels')
    .select('id')
    .eq('account_id', accountId)
    .limit(1);
  if (!anyChannel || anyChannel.length === 0) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/resolve-conversation.test.ts`
Expected: PASS (all existing tests + the new one)

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/resolve-conversation.ts src/lib/whatsapp/resolve-conversation.test.ts
git commit -m "fix: resolve-conversation's WhatsApp-configured check covers every provider"
```

---

### Task 6: `config/route.ts` mirrors status onto `channels`

**Files:**
- Modify: `src/app/api/whatsapp/config/route.ts`
- Create: `src/app/api/whatsapp/config/route.test.ts` (none exists today)

**Interfaces:**
- Consumes: `setChannelStatus` from `@/lib/whatsapp/channel-status` (Task 1).

**Context:** Read the full current `POST` handler (already read in full during planning — see the insert/update branches near the end of the function, right after `baseRow` is built). After the row is saved (insert or update branch), the handler needs the affected row's `channel_id` so it can call `setChannelStatus`. The insert path doesn't currently `.select()` anything back; the update path doesn't either. Cheapest fix: after either branch succeeds, do one follow-up `select('channel_id')` by `account_id` (the row is guaranteed to exist by then — the auto-provision trigger, migration 039, fills `channel_id` on insert).

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/whatsapp/config/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  state: {
    channelStatusCalls: [] as { channelId: string; status: string }[],
  },
}))

vi.mock('@/lib/whatsapp/channel-status', () => ({
  setChannelStatus: vi.fn(async (_db: unknown, channelId: string, status: string) => {
    h.state.channelStatusCalls.push({ channelId, status })
  }),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  registerPhoneNumber: vi.fn(async () => ({})),
  subscribeWabaToApp: vi.fn(async () => ({})),
  verifyPhoneNumber: vi.fn(async () => ({ verified_name: 'Ada Co' })),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      if (table === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { account_id: 'acc-1' }, error: null }) }) }) }
      }
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
          }),
          insert: () => ({ channel_id: undefined }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              neq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
            }),
          }),
          insert: () => Promise.resolve({ error: null }),
        }
      }
      if (table === 'meta_channels') {
        // Follow-up channel_id lookup after insert/update.
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: { channel_id: 'ch-1' }, error: null }) }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { POST } from './route'

function req(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Request
}

beforeEach(() => {
  h.state.channelStatusCalls = []
})

describe('POST /api/whatsapp/config', () => {
  it('mirrors the resulting status onto channels via setChannelStatus', async () => {
    await POST(
      req({ phone_number_id: 'pn-1', waba_id: 'waba-1', access_token: 'tok-1' })
    )
    expect(h.state.channelStatusCalls).toContainEqual({ channelId: 'ch-1', status: 'connected' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/config/route.test.ts`
Expected: FAIL — `setChannelStatus` is never called today.

- [ ] **Step 3: Write the implementation**

In `src/app/api/whatsapp/config/route.ts`, add the import:

```ts
import { setChannelStatus } from '@/lib/whatsapp/channel-status'
```

Immediately after the existing insert/update branch (right before the `if (registrationError) { ... }` block near the end of `POST`), add:

```ts
    // Mirror the resulting connection status onto channels.status too —
    // meta_channels.status alone isn't enough once an account can have
    // more than one channel (resolveChannelForSend's no-default fallback
    // reads channels.status, not meta_channels.status).
    const { data: savedRow } = await supabase
      .from('meta_channels')
      .select('channel_id')
      .eq('account_id', accountId)
      .maybeSingle()
    if (savedRow?.channel_id) {
      await setChannelStatus(
        supabaseAdmin(),
        savedRow.channel_id,
        registrationError ? 'disconnected' : 'connected'
      )
    }
```

(`supabaseAdmin()` — the lazily-initialised service-role client already defined at the top of this file — is used rather than the session-scoped `supabase`, matching how the rest of this route already reaches for elevated access for cross-cutting writes.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/whatsapp/config/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/whatsapp/config/route.ts src/app/api/whatsapp/config/route.test.ts
git commit -m "feat: mirror WhatsApp config status onto channels.status"
```

---

### Task 7: `/api/channels` — list, label, default, remove

**Files:**
- Modify: `src/types/index.ts` — add `Channel` interface (see frozen Interfaces section) right after the existing `WhatsAppConfig` interface (`src/types/index.ts:269-288`).
- Create: `src/app/api/channels/route.ts`
- Create: `src/app/api/channels/[id]/route.ts`
- Test: `src/app/api/channels/route.test.ts`
- Test: `src/app/api/channels/[id]/route.test.ts`

**Interfaces:**
- Consumes: `requireRole`, `toErrorResponse` from `@/lib/auth/account` (existing); `disconnectUazapiInstance` from `@/lib/whatsapp/uazapi-api` (Task 2); `decrypt` from `@/lib/whatsapp/encryption` (existing).
- Produces: `GET /api/channels` (`ChannelsListResponse`, see frozen Interfaces section), `PATCH /api/channels/[id]` (body `{ label?, is_default? }`), `DELETE /api/channels/[id]`.

**Context:** `channels` table RLS (migration 039) requires `is_account_member(account_id, 'admin')` for insert/update/delete, `is_account_member(account_id)` (any role) for select — so `GET` uses `requireRole('agent')` (read, any operational role) and `PATCH`/`DELETE` use `requireRole('admin')`. Deletion is provider-aware: a Meta channel is removed by deleting its `meta_channels` row (the existing `AFTER DELETE` trigger, migration 039, cleans up the `channels` row); a UAZAPI channel is removed by deleting the `channels` row directly (its `uazapi_channels` row cascades via `ON DELETE CASCADE` — no trigger loop, since `uazapi_channels` has no reverse-delete trigger). Best-effort disconnect the UAZAPI instance server-side first; a failure there must not block local cleanup.

- [ ] **Step 1: Add the `Channel` type**

```ts
// src/types/index.ts — insert after the WhatsAppConfig interface
export interface Channel {
  id: string;
  account_id: string;
  provider: 'meta' | 'uazapi';
  label: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  is_default: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/app/api/channels/route.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: db, accountId: 'acc-1', userId: 'user-1', role: 'agent', account: { id: 'acc-1', name: 'Acc' } })),
  toErrorResponse: (err: unknown) => ({ body: { error: String(err) }, init: { status: 500 } }),
}))

const db = {
  from: (table: string) => {
    if (table === 'channels') {
      return {
        select: () => ({
          eq: () => ({
            order: () =>
              Promise.resolve({
                data: [
                  { id: 'ch-1', provider: 'meta', label: 'WhatsApp', status: 'connected', is_default: true },
                  { id: 'ch-2', provider: 'uazapi', label: 'Sales', status: 'connecting', is_default: false },
                ],
                error: null,
              }),
          }),
        }),
      }
    }
    if (table === 'meta_channels') {
      return {
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: [
                { channel_id: 'ch-1', phone_number_id: 'pn-1', waba_id: 'waba-1', registered_at: '2026-01-01', last_registration_error: null },
              ],
              error: null,
            }),
        }),
      }
    }
    if (table === 'uazapi_channels') {
      return {
        select: () => ({
          in: () =>
            Promise.resolve({
              data: [
                { channel_id: 'ch-2', instance_id: 'inst-1', base_url: 'https://x', connected_phone: null, profile_name: null, last_error: null },
              ],
              error: null,
            }),
        }),
      }
    }
    throw new Error(`unexpected table: ${table}`)
  },
}

import { GET } from './route'

describe('GET /api/channels', () => {
  it('merges channels with their provider-specific detail', async () => {
    const res = (await GET()) as unknown as { body: { channels: Array<Record<string, unknown>> } }
    expect(res.body.channels).toHaveLength(2)
    expect(res.body.channels[0]).toMatchObject({
      id: 'ch-1',
      provider: 'meta',
      meta: { phone_number_id: 'pn-1' },
    })
    expect(res.body.channels[1]).toMatchObject({
      id: 'ch-2',
      provider: 'uazapi',
      uazapi: { instance_id: 'inst-1' },
    })
  })
})
```

```ts
// src/app/api/channels/[id]/route.test.ts
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: { patch: [] as unknown[], deletedTables: [] as string[] },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: db, accountId: 'acc-1', userId: 'user-1', role: 'admin', account: { id: 'acc-1', name: 'Acc' } })),
  toErrorResponse: (err: unknown) => ({ body: { error: String(err) }, init: { status: 500 } }),
}))
vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  disconnectUazapiInstance: vi.fn(async () => {}),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))

let channelProvider = 'meta'

const db = {
  from: (table: string) => {
    if (table === 'channels') {
      return {
        select: () => ({
          eq: () => ({ single: () => Promise.resolve({ data: { id: 'ch-1', account_id: 'acc-1', provider: channelProvider }, error: null }) }),
        }),
        update: (patch: unknown) => {
          h.calls.patch.push(patch)
          return { eq: () => Promise.resolve({ error: null }) }
        },
        delete: () => {
          h.calls.deletedTables.push('channels')
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    }
    if (table === 'meta_channels') {
      return { delete: () => { h.calls.deletedTables.push('meta_channels'); return { eq: () => Promise.resolve({ error: null }) } } }
    }
    if (table === 'uazapi_channels') {
      return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { base_url: 'https://x', instance_token: 'tok' }, error: null }) }) }),
      }
    }
    throw new Error(`unexpected table: ${table}`)
  },
}

import { PATCH, DELETE } from './route'

function req(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Request
}
const ctx = { params: Promise.resolve({ id: 'ch-1' }) }

describe('PATCH /api/channels/[id]', () => {
  it('clears the account default before setting a new one', async () => {
    channelProvider = 'meta'
    h.calls.patch = []
    await PATCH(req({ is_default: true }), ctx)
    expect(h.calls.patch).toEqual([
      { is_default: false },
      { is_default: true, updated_at: expect.any(String) },
    ])
  })

  it('updates the label', async () => {
    h.calls.patch = []
    await PATCH(req({ label: 'Support' }), ctx)
    expect(h.calls.patch).toContainEqual({ label: 'Support', updated_at: expect.any(String) })
  })
})

describe('DELETE /api/channels/[id]', () => {
  it('deletes via meta_channels for a Meta channel', async () => {
    channelProvider = 'meta'
    h.calls.deletedTables = []
    await DELETE(req({}), ctx)
    expect(h.calls.deletedTables).toEqual(['meta_channels'])
  })

  it('deletes the channels row directly for a UAZAPI channel', async () => {
    channelProvider = 'uazapi'
    h.calls.deletedTables = []
    await DELETE(req({}), ctx)
    expect(h.calls.deletedTables).toEqual(['channels'])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/app/api/channels`
Expected: FAIL — neither route file exists yet.

- [ ] **Step 4: Write the implementation**

```ts
// src/app/api/channels/route.ts
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
```

```ts
// src/app/api/channels/[id]/route.ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { disconnectUazapiInstance } from '@/lib/whatsapp/uazapi-api'

interface RouteContext {
  params: Promise<{ id: string }>
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
      .select('id, account_id, provider')
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
    return NextResponse.json({ success: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/app/api/channels`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/app/api/channels
git commit -m "feat: add /api/channels list/label/default/remove endpoints"
```

---

### Task 8: `/api/uazapi/instance` — create + QR poll

**Files:**
- Create: `src/app/api/uazapi/instance/route.ts`
- Create: `src/app/api/uazapi/instance/[channelId]/route.ts`
- Test: `src/app/api/uazapi/instance/route.test.ts`
- Test: `src/app/api/uazapi/instance/[channelId]/route.test.ts`

**Interfaces:**
- Consumes: `initUazapiInstance`, `connectUazapiInstance`, `fetchUazapiInstanceStatus` from `@/lib/whatsapp/uazapi-api` (Task 2); `setChannelStatus` from `@/lib/whatsapp/channel-status` (Task 1); `encrypt`, `decrypt` from `@/lib/whatsapp/encryption`; `requireRole`, `toErrorResponse` from `@/lib/auth/account`.
- Produces: `POST /api/uazapi/instance`, `GET /api/uazapi/instance/[channelId]` — see frozen Interfaces section.

**Context:** Creating a channel is a two-row insert (`channels` then `uazapi_channels`) plus two outbound UAZAPI calls (init, then connect for the first QR). `is_default` for the new channel is `true` only when the account currently has zero channels (preserves today's implicit single-channel behavior; every subsequent channel — Meta or UAZAPI — defaults to non-default, matching the design spec's explicit-opt-in "definir como padrão" action). `webhook_secret` is generated locally (`crypto.randomBytes`) rather than supplied by UAZAPI, since the UAZAPI webhook route (Task 9) validates inbound requests against it.

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/uazapi/instance/route.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: db, accountId: 'acc-1', userId: 'user-1', role: 'admin', account: { id: 'acc-1', name: 'Acc' } })),
  toErrorResponse: (err: unknown) => ({ body: { error: String(err) }, init: { status: 500 } }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (v: string) => `enc:${v}` }))
vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  initUazapiInstance: vi.fn(async () => ({ id: 'inst-1', token: 'raw-token' })),
  connectUazapiInstance: vi.fn(async () => ({ status: 'connecting', qrCode: 'base64qr' })),
}))

const inserted: { table: string; row: Record<string, unknown> }[] = []

const db = {
  from: (table: string) => {
    if (table === 'channels') {
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }), // zero existing channels
        insert: (row: Record<string, unknown>) => {
          inserted.push({ table, row })
          return { select: () => ({ single: () => Promise.resolve({ data: { id: 'ch-new' }, error: null }) }) }
        },
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }
    }
    if (table === 'uazapi_channels') {
      return {
        insert: (row: Record<string, unknown>) => {
          inserted.push({ table, row })
          return Promise.resolve({ error: null })
        },
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }
    }
    throw new Error(`unexpected table: ${table}`)
  },
}

import { POST } from './route'

function req(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Request
}

describe('POST /api/uazapi/instance', () => {
  it('creates channels + uazapi_channels rows and returns the first QR', async () => {
    inserted.length = 0
    const res = (await POST(req({ label: 'Sales', base_url: 'https://demo.uazapi.example' }))) as unknown as {
      body: { channelId: string; qrCode: string | null }
    }
    expect(res.body).toEqual({ channelId: 'ch-new', qrCode: 'base64qr' })

    const channelInsert = inserted.find((i) => i.table === 'channels')!
    expect(channelInsert.row).toMatchObject({
      account_id: 'acc-1',
      provider: 'uazapi',
      label: 'Sales',
      status: 'connecting',
      is_default: true, // zero prior channels
    })

    const uazapiInsert = inserted.find((i) => i.table === 'uazapi_channels')!
    expect(uazapiInsert.row).toMatchObject({
      channel_id: 'ch-new',
      instance_id: 'inst-1',
      instance_token: 'enc:raw-token',
      base_url: 'https://demo.uazapi.example',
      qr_code: 'base64qr',
    })
  })

  it('rejects a missing base_url', async () => {
    const res = (await POST(req({ label: 'Sales' }))) as unknown as { init: { status: number } }
    expect(res.init.status).toBe(400)
  })
})
```

```ts
// src/app/api/uazapi/instance/[channelId]/route.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: db, accountId: 'acc-1', userId: 'user-1', role: 'agent', account: { id: 'acc-1', name: 'Acc' } })),
  toErrorResponse: (err: unknown) => ({ body: { error: String(err) }, init: { status: 500 } }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v.replace(/^enc:/, '') }))
vi.mock('@/lib/whatsapp/channel-status', () => ({ setChannelStatus: vi.fn(async () => {}) }))

let statusResult: { status: string; phone?: string; profileName?: string } = { status: 'connecting' }
let connectResult: { status: string; qrCode?: string } = { status: 'connecting', qrCode: 'fresh-qr' }
const updateCalls: Record<string, unknown>[] = []

vi.mock('@/lib/whatsapp/uazapi-api', () => ({
  fetchUazapiInstanceStatus: vi.fn(async () => statusResult),
  connectUazapiInstance: vi.fn(async () => connectResult),
}))

const db = {
  from: (table: string) => {
    if (table === 'uazapi_channels') {
      return {
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: { channel_id: 'ch-1', base_url: 'https://x', instance_token: 'enc:tok', status_cache: 'connecting' },
                error: null,
              }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          updateCalls.push(patch)
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    }
    throw new Error(`unexpected table: ${table}`)
  },
}

import { GET } from './route'
const ctx = { params: Promise.resolve({ channelId: 'ch-1' }) }

describe('GET /api/uazapi/instance/[channelId]', () => {
  it('returns connected + phone once UAZAPI reports connected, and updates the row', async () => {
    updateCalls.length = 0
    statusResult = { status: 'connected', phone: '5511999998888', profileName: 'Ada' }
    const res = (await GET(new Request('http://x'), ctx)) as unknown as {
      body: { status: string; phone?: string; profileName?: string }
    }
    expect(res.body).toEqual({ status: 'connected', phone: '5511999998888', profileName: 'Ada' })
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ connected_phone: '5511999998888', profile_name: 'Ada', qr_code: null })
    )
  })

  it('refreshes the QR while still connecting', async () => {
    statusResult = { status: 'connecting' }
    connectResult = { status: 'connecting', qrCode: 'refreshed-qr' }
    const res = (await GET(new Request('http://x'), ctx)) as unknown as { body: { status: string; qrCode?: string } }
    expect(res.body).toEqual({ status: 'connecting', qrCode: 'refreshed-qr' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/uazapi/instance`
Expected: FAIL — routes don't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// src/app/api/uazapi/instance/route.ts
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
```

```ts
// src/app/api/uazapi/instance/[channelId]/route.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/uazapi/instance`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/uazapi/instance
git commit -m "feat: add UAZAPI instance create + QR-poll endpoints"
```

---

### Task 9: `/api/uazapi/webhook` — inbound

**Files:**
- Create: `src/app/api/uazapi/webhook/route.ts`
- Test: `src/app/api/uazapi/webhook/route.test.ts`

**Interfaces:**
- Consumes: `processInboundMessage`, `handleStatusUpdate`, `NormalizedInboundMessage` from `@/lib/whatsapp/inbound-processor` (Plan 3, unchanged); `decrypt` from `@/lib/whatsapp/encryption`; `resolveAuditUserId` from `@/lib/api/v1/contacts` (existing, used as the `created_by`-is-null fallback).

**Context:** Read `src/app/api/whatsapp/webhook/route.ts`'s `POST` handler and `supabaseAdmin()` helper first — same shape (unauthenticated public endpoint, service-role client, build `NormalizedInboundMessage`, delegate). **Inbound payload shape is a best-effort assumption**, documented in this file's header, same caveat as `uazapi-api.ts` (Task 2):

```
{
  instance_id: string,
  event: 'message' | 'status',
  message?: {
    id: string, from: string, fromName?: string,
    type: 'text' | 'image' | 'video' | 'document' | 'audio' | 'button' | 'list' | 'reaction',
    text?: string, mediaUrl?: string, caption?: string,
    buttonId?: string, listId?: string, quotedMessageId?: string,
    reaction?: { emoji: string, targetMessageId: string },
    timestamp?: number,
  },
  status?: { messageId: string, status: 'sent' | 'delivered' | 'read' | 'failed', recipientId?: string, timestamp?: number },
}
```

Auth is per-channel: header `x-uazapi-secret` compared against the target instance's decrypted `webhook_secret` — the instance must be identified first (via `instance_id` in the body) before the secret can be checked, so the body is parsed before the auth check.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/uazapi/webhook/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  processInboundMessage: vi.fn(async () => ({ consumed: true })),
  handleStatusUpdate: vi.fn(async () => {}),
}))

vi.mock('@/lib/whatsapp/inbound-processor', () => ({
  processInboundMessage: h.processInboundMessage,
  handleStatusUpdate: h.handleStatusUpdate,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v.replace(/^enc:/, '') }))
vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: vi.fn(async () => 'fallback-owner'),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'uazapi_channels') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: {
                    channel_id: 'ch-1',
                    webhook_secret: 'enc:the-secret',
                    channels: { id: 'ch-1', account_id: 'acc-1', created_by: 'owner-1' },
                  },
                  error: null,
                }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { POST } from './route'

function req(body: Record<string, unknown>, secret = 'the-secret') {
  return {
    text: async () => JSON.stringify(body),
    headers: { get: (name: string) => (name === 'x-uazapi-secret' ? secret : null) },
  } as unknown as Request
}

beforeEach(() => {
  h.processInboundMessage.mockClear()
  h.handleStatusUpdate.mockClear()
})

describe('POST /api/uazapi/webhook', () => {
  it('rejects a request with a wrong or missing secret', async () => {
    const res = await POST(req({ instance_id: 'inst-1', event: 'message', message: { id: 'm1', from: '5511999998888', type: 'text', text: 'hi' } }, 'wrong'))
    expect((res as unknown as { init?: { status: number } }).init?.status).toBe(401)
    expect(h.processInboundMessage).not.toHaveBeenCalled()
  })

  it('normalizes a text message and calls processInboundMessage', async () => {
    await POST(
      req({
        instance_id: 'inst-1',
        event: 'message',
        message: { id: 'm1', from: '5511999998888', fromName: 'Ada', type: 'text', text: 'hi', timestamp: 1700000000 },
      })
    )
    expect(h.processInboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelId: 'ch-1',
        accountId: 'acc-1',
        from: '5511999998888',
        contactName: 'Ada',
        waMessageId: 'm1',
        type: 'text',
        text: 'hi',
        providerType: 'text',
      })
    )
  })

  it('normalizes a button tap to an interactive reply', async () => {
    await POST(
      req({
        instance_id: 'inst-1',
        event: 'message',
        message: { id: 'm2', from: '5511999998888', type: 'button', buttonId: 'YES', text: 'Yes please' },
      })
    )
    expect(h.processInboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'interactive', interactiveReplyId: 'YES', providerType: 'button' })
    )
  })

  it('normalizes a reaction and sets replyToWaMessageId to the reaction target', async () => {
    await POST(
      req({
        instance_id: 'inst-1',
        event: 'message',
        message: { id: 'm3', from: '5511999998888', type: 'reaction', reaction: { emoji: '👍', targetMessageId: 'm1' } },
      })
    )
    expect(h.processInboundMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'reaction', reactionEmoji: '👍', replyToWaMessageId: 'm1' })
    )
  })

  it('routes a status event to handleStatusUpdate', async () => {
    await POST(
      req({
        instance_id: 'inst-1',
        event: 'status',
        status: { messageId: 'm1', status: 'delivered', timestamp: 1700000000 },
      })
    )
    expect(h.handleStatusUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'm1', status: 'delivered' })
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/uazapi/webhook/route.test.ts`
Expected: FAIL — route doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// src/app/api/uazapi/webhook/route.ts
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
  if (!expectedSecret || providedSecret !== expectedSecret) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/uazapi/webhook/route.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/uazapi/webhook
git commit -m "feat: add inbound UAZAPI webhook route"
```

---

### Task 10: Migrate `/api/whatsapp/react` off direct `whatsapp_config`

**Files:**
- Modify: `src/app/api/whatsapp/react/route.ts`
- Test: `src/app/api/whatsapp/react/route.test.ts` (none exists today)

**Interfaces:**
- Consumes: `resolveChannelForSend`, `ChannelResolutionError` from `@/lib/whatsapp/channel-resolution` (existing, Plan 2).

**Context:** Read the full current file (already read in full during planning). It queries `whatsapp_config` by `account_id` alone, ignoring which channel the conversation is actually on — wrong the moment an account has 2+ channels, and reactions have no UAZAPI implementation in this plan (no `sendReaction` on `WhatsAppProvider` — out of scope, matches the design spec's silence on UAZAPI reactions). The fix: resolve the conversation's real channel; if it isn't Meta, return a clear 400 instead of silently reacting through whichever channel `whatsapp_config` happened to point at.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/whatsapp/react/route.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: db, accountId: 'acc-1', userId: 'user-1', role: 'agent', account: { id: 'acc-1', name: 'Acc' } })),
  toErrorResponse: (err: unknown) => ({ body: { error: String(err) }, init: { status: 500 } }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => ({ body: { error: 'rate limited' }, init: { status: 429 } }),
  RATE_LIMITS: { react: {} },
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => v }))
vi.mock('@/lib/whatsapp/phone-utils', () => ({ sanitizePhoneForMeta: (p: string) => p }))

const sendReactionMessage = vi.fn(async () => ({}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendReactionMessage: (...args: unknown[]) => (sendReactionMessage as unknown as (...a: unknown[]) => unknown)(...args),
}))

let resolvedProvider: 'meta' | 'uazapi' = 'meta'
vi.mock('@/lib/whatsapp/channel-resolution', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp/channel-resolution')>(
    '@/lib/whatsapp/channel-resolution'
  )
  return {
    ...actual,
    resolveChannelForSend: vi.fn(async () => ({ channelId: 'ch-1', provider: resolvedProvider })),
  }
})

const db = {
  from: (table: string) => {
    if (table === 'messages') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'msg-1', message_id: 'wamid.1', conversation_id: 'conv-1' }, error: null }) }) }) }
    }
    if (table === 'conversations') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { id: 'conv-1', account_id: 'acc-1', channel_id: 'ch-1', contact: { phone: '+15551230000' } }, error: null }),
            }),
          }),
        }),
      }
    }
    if (table === 'meta_channels') {
      return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { phone_number_id: 'pn-1', access_token: 'tok' }, error: null }) }) }),
      }
    }
    if (table === 'message_reactions') {
      return { upsert: () => Promise.resolve({ error: null }), delete: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }) }
    }
    throw new Error(`unexpected table: ${table}`)
  },
}

import { POST } from './route'

function req(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Request
}

describe('POST /api/whatsapp/react', () => {
  it('sends via meta-api using the conversation channel, not a blind account lookup', async () => {
    resolvedProvider = 'meta'
    const res = (await POST(req({ message_id: 'msg-1', emoji: '👍' }))) as unknown as { body?: { success: boolean } }
    expect(sendReactionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: 'pn-1', accessToken: 'tok' })
    )
    expect(res.body).toEqual({ success: true })
  })

  it('returns 400 when the conversation is on a non-Meta channel', async () => {
    resolvedProvider = 'uazapi'
    const res = (await POST(req({ message_id: 'msg-1', emoji: '👍' }))) as unknown as { init?: { status: number } }
    expect(res.init?.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/react/route.test.ts`
Expected: FAIL — current code queries `whatsapp_config` by account, ignoring `resolveChannelForSend` entirely.

- [ ] **Step 3: Write the implementation**

In `src/app/api/whatsapp/react/route.ts`:

Add the import:

```ts
import { resolveChannelForSend, ChannelResolutionError } from '@/lib/whatsapp/channel-resolution';
```

Change the conversation select to include `channel_id`:

```ts
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, account_id, channel_id, contact:contacts(phone)')
      .eq('id', targetMessage.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();
```

Replace the `whatsapp_config` block:

```ts
    // WhatsApp config + access token. Account-scoped post-multi-user.
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .single();

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }

    const accessToken = decrypt(config.access_token);
```

with:

```ts
    // Resolve the conversation's actual channel (its own channel_id, or
    // the account default) rather than assuming the account's single
    // legacy `whatsapp_config` row — required now that an account can
    // have more than one channel.
    let resolvedChannel;
    try {
      resolvedChannel = await resolveChannelForSend(supabase, accountId, conversation.channel_id ?? null);
    } catch (err) {
      if (err instanceof ChannelResolutionError) {
        return NextResponse.json({ error: err.message }, { status: err.code === 'ambiguous' ? 409 : 400 });
      }
      throw err;
    }

    if (resolvedChannel.provider !== 'meta') {
      // No sendReaction on WhatsAppProvider yet — reactions are
      // Meta-only in this plan (the design spec is silent on UAZAPI
      // reactions; adding one is a future, explicit decision).
      return NextResponse.json(
        { error: 'Reactions are only supported on Meta WhatsApp channels today.' },
        { status: 400 },
      );
    }

    const { data: metaChannel, error: metaChannelError } = await supabase
      .from('meta_channels')
      .select('phone_number_id, access_token')
      .eq('channel_id', resolvedChannel.channelId)
      .single();

    if (metaChannelError || !metaChannel) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }

    const accessToken = decrypt(metaChannel.access_token);
```

And update the two remaining uses of `config.phone_number_id` (in the `sendReactionMessage` call) to `metaChannel.phone_number_id`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/whatsapp/react/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/whatsapp/react/route.ts src/app/api/whatsapp/react/route.test.ts
git commit -m "fix: react route resolves the conversation's real channel"
```

---

### Task 11: Migrate `/api/whatsapp/broadcast` off direct `meta-api.ts`

**Files:**
- Modify: `src/app/api/whatsapp/broadcast/route.ts`
- Test: `src/app/api/whatsapp/broadcast/route.test.ts` (none exists today)

**Interfaces:**
- Consumes: `resolveChannelForSend`, `resolveProvider`, `ChannelResolutionError` from `@/lib/whatsapp/channel-resolution` (existing + Task 4).

**Context:** Read the full current file (already read in full during planning). It decrypts `whatsapp_config.access_token` directly and calls `sendTemplateMessage` from `meta-api.ts`. Per the design spec, broadcasts need an explicit channel field; this makes `channel_id` an optional body field (omitted = today's implicit single/default-channel behavior via `resolveChannelForSend`'s existing fallback chain, so existing callers keep working unchanged).

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/whatsapp/broadcast/route.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: db, accountId: 'acc-1', userId: 'user-1', role: 'agent', account: { id: 'acc-1', name: 'Acc' } })),
  toErrorResponse: (err: unknown) => ({ body: { error: String(err) }, init: { status: 500 } }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => ({ body: { error: 'rate limited' }, init: { status: 429 } }),
  RATE_LIMITS: { broadcast: {} },
}))
vi.mock('@/lib/whatsapp/phone-utils', () => ({
  sanitizePhoneForMeta: (p: string) => p,
  isValidE164: () => true,
  phoneVariants: (p: string) => [p],
  isRecipientNotAllowedError: () => false,
}))
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: vi.fn(async () => ({ row: { name: 'promo', body_text: 'hi' }, malformed: false, language: 'en_US' })),
}))

const sendTemplate = vi.fn(async () => ({ messageId: 'sent-1' }))
vi.mock('@/lib/whatsapp/channel-resolution', () => ({
  resolveChannelForSend: vi.fn(async () => ({ channelId: 'ch-1', provider: 'meta' })),
  resolveProvider: vi.fn(async () => ({ sendTemplate })),
  ChannelResolutionError: class extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))

const db = {}

import { POST } from './route'

function req(body: Record<string, unknown>) {
  return { json: async () => body } as unknown as Request
}

describe('POST /api/whatsapp/broadcast', () => {
  it('sends via the resolved provider instead of calling meta-api directly', async () => {
    const res = (await POST(
      req({ recipients: [{ phone: '+15551230000', params: [] }], template_name: 'promo' })
    )) as unknown as { body: { sent: number; failed: number } }
    expect(sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+15551230000', templateName: 'promo' })
    )
    expect(res.body).toMatchObject({ sent: 1, failed: 0 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/broadcast/route.test.ts`
Expected: FAIL — current code calls `meta-api.ts`'s `sendTemplateMessage` directly, never `resolveProvider`.

- [ ] **Step 3: Write the implementation**

In `src/app/api/whatsapp/broadcast/route.ts`:

Replace the imports:

```ts
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { resolveChannelForSend, resolveProvider, ChannelResolutionError } from '@/lib/whatsapp/channel-resolution'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
```

(drops `sendTemplateMessage` from `@/lib/whatsapp/meta-api` and `decrypt` from `@/lib/whatsapp/encryption` — neither is used anymore.)

Destructure the new optional body field alongside the existing ones:

```ts
    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      channel_id,
    } = body
```

Replace the `whatsapp_config` block:

```ts
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)
```

with:

```ts
    let resolvedChannel
    try {
      resolvedChannel = await resolveChannelForSend(supabase, accountId, channel_id ?? null)
    } catch (err) {
      if (err instanceof ChannelResolutionError) {
        return NextResponse.json({ error: err.message }, { status: err.code === 'ambiguous' ? 409 : 400 })
      }
      throw err
    }

    let provider
    try {
      provider = await resolveProvider(supabase, resolvedChannel)
    } catch (err) {
      if (err instanceof ChannelResolutionError) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      throw err
    }
```

And inside the per-recipient loop, replace the `sendTemplateMessage` call:

```ts
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: template_name,
            language: resolvedTemplate.language,
            template: templateRow ?? undefined,
            messageParams: recipient.messageParams,
            params: recipient.params ?? [],
          })
```

with:

```ts
          const result = await provider.sendTemplate({
            to: variant,
            templateName: template_name,
            language: resolvedTemplate.language,
            template: templateRow ?? undefined,
            messageParams: recipient.messageParams,
            params: recipient.params ?? [],
          })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/whatsapp/broadcast/route.test.ts`
Expected: PASS

- [ ] **Step 5: Run the broader suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS — `broadcast-core.ts` (the newer, RPC-backed create path) is untouched by this task; this task only fixes the older direct-send route.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/broadcast/route.ts src/app/api/whatsapp/broadcast/route.test.ts
git commit -m "fix: broadcast route sends via the resolved channel's provider"
```

---

### Task 12: Settings UI — `ChannelsList` + page wiring

**Files:**
- Create: `src/components/settings/channels-list.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx:14,77`
- Modify: `messages/en.json`, `messages/pt-BR.json`, `messages/ko.json` — add `Settings.whatsapp.channels.*`

**Interfaces:**
- Consumes: `Channel` type from `@/types` (Task 7); `GET /api/channels`, `PATCH /api/channels/[id]`, `DELETE /api/channels/[id]` (Task 7); existing `WhatsAppConfig` component (unchanged, `@/components/settings/whatsapp-config`); `UazapiChannelForm` (Task 13 — stub it in this task, fill in Task 13).
- Produces: `<ChannelsList />`, default export of `channels-list.tsx`.

**Context:** This codebase has exactly one component test in the whole tree (`dropdown-menu-group-label.test.tsx`) — component testing isn't the established convention here (`whatsapp-config.tsx` itself has none). This task's verification step is `npm run typecheck` + a manual smoke check, not a Vitest component test, matching that precedent. Read `src/components/settings/whatsapp-config.tsx` in full first for the Card/Alert/Button/Badge styling conventions to match, and `src/components/ui/dialog.tsx` for the Dialog primitives.

Per the design spec, the Meta form ("`WhatsAppConfig` vira `MetaChannelForm`, reusado como está") is reused **unmodified** — it stays account-scoped to the single Meta row exactly as it works today; this task only wraps it inside the new channel-list/add-channel UI, it does not rename or restructure it.

- [ ] **Step 1: Add a stub `UazapiChannelForm` so this task typechecks standalone**

```tsx
// src/components/settings/uazapi-channel-form.tsx
// Filled in by Task 13 — this task only needs the export to exist so
// ChannelsList typechecks. Task 13 replaces this file entirely.
'use client';

export function UazapiChannelForm({ onConnected }: { onConnected: () => void }) {
  void onConnected;
  return null;
}
```

- [ ] **Step 2: Add i18n keys**

Add a `channels` object inside the existing `Settings.whatsapp` namespace in all three locale files, alongside the existing keys (do not remove or rename any existing key — the form's own strings are untouched).

`messages/en.json` (inside `Settings.whatsapp`):

```json
  "channels": {
    "heading": "Channels",
    "headingDesc": "Every WhatsApp connection on this account. Add as many as you need.",
    "addChannel": "Add channel",
    "chooseProvider": "Choose a provider",
    "chooseProviderDesc": "Pick which kind of WhatsApp connection to add.",
    "providerMeta": "Meta WhatsApp Cloud API",
    "providerMetaDesc": "Official API. Requires a Meta Business/App setup.",
    "providerUazapi": "UAZAPI (QR code)",
    "providerUazapiDesc": "Unofficial API. Connect by scanning a QR code, like WhatsApp Web.",
    "default": "Default",
    "setDefault": "Set as default",
    "remove": "Remove",
    "removeConfirm": "Remove this channel? Conversations already using it keep their history, but new messages won't be able to send through it.",
    "renaming": "Saving…",
    "editLabel": "Rename",
    "notConnected": "Not connected",
    "connecting": "Connecting…",
    "connectionError": "Connection error",
    "loadFailed": "Failed to load channels.",
    "empty": "No WhatsApp channel connected yet."
  }
```

`messages/pt-BR.json` (inside `Settings.whatsapp`):

```json
  "channels": {
    "heading": "Canais",
    "headingDesc": "Todas as conexões de WhatsApp desta conta. Adicione quantas precisar.",
    "addChannel": "Adicionar canal",
    "chooseProvider": "Escolha um provedor",
    "chooseProviderDesc": "Escolha que tipo de conexão de WhatsApp adicionar.",
    "providerMeta": "Meta WhatsApp Cloud API",
    "providerMetaDesc": "API oficial. Requer configuração de App/Business da Meta.",
    "providerUazapi": "UAZAPI (QR code)",
    "providerUazapiDesc": "API não-oficial. Conecte escaneando um QR code, como no WhatsApp Web.",
    "default": "Padrão",
    "setDefault": "Definir como padrão",
    "remove": "Remover",
    "removeConfirm": "Remover este canal? As conversas que já o usam mantêm o histórico, mas novas mensagens não poderão ser enviadas por ele.",
    "renaming": "Salvando…",
    "editLabel": "Renomear",
    "notConnected": "Não conectado",
    "connecting": "Conectando…",
    "connectionError": "Erro de conexão",
    "loadFailed": "Falha ao carregar os canais.",
    "empty": "Nenhum canal de WhatsApp conectado ainda."
  }
```

`messages/ko.json` (inside `Settings.whatsapp`):

```json
  "channels": {
    "heading": "채널",
    "headingDesc": "이 계정의 모든 WhatsApp 연결입니다. 필요한 만큼 추가하세요.",
    "addChannel": "채널 추가",
    "chooseProvider": "제공자 선택",
    "chooseProviderDesc": "추가할 WhatsApp 연결 종류를 선택하세요.",
    "providerMeta": "Meta WhatsApp Cloud API",
    "providerMetaDesc": "공식 API입니다. Meta 비즈니스/앱 설정이 필요합니다.",
    "providerUazapi": "UAZAPI (QR 코드)",
    "providerUazapiDesc": "비공식 API입니다. WhatsApp Web처럼 QR 코드를 스캔해 연결합니다.",
    "default": "기본",
    "setDefault": "기본으로 설정",
    "remove": "제거",
    "removeConfirm": "이 채널을 제거하시겠습니까? 이미 사용 중인 대화는 기록이 유지되지만, 이 채널로는 더 이상 새 메시지를 보낼 수 없습니다.",
    "renaming": "저장 중…",
    "editLabel": "이름 변경",
    "notConnected": "연결되지 않음",
    "connecting": "연결 중…",
    "connectionError": "연결 오류",
    "loadFailed": "채널을 불러오지 못했습니다.",
    "empty": "아직 연결된 WhatsApp 채널이 없습니다."
  }
```

- [ ] **Step 3: Write `ChannelsList`**

```tsx
// src/components/settings/channels-list.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Plus,
  Star,
  Trash2,
  Pencil,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfig } from './whatsapp-config';
import { UazapiChannelForm } from './uazapi-channel-form';
import type { Channel } from '@/types';

type ChannelWithDetail = Channel & {
  meta?: { phone_number_id: string; waba_id: string | null; registered_at: string | null; last_registration_error: string | null };
  uazapi?: { instance_id: string; base_url: string; connected_phone: string | null; profile_name: string | null; last_error: string | null };
};

function statusBadge(status: Channel['status'], t: (key: string) => string) {
  switch (status) {
    case 'connected':
      return (
        <Badge variant="secondary" className="gap-1 text-emerald-400">
          <CheckCircle2 className="size-3" /> {status}
        </Badge>
      );
    case 'error':
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="size-3" /> {t('connectionError')}
        </Badge>
      );
    case 'connecting':
      return (
        <Badge variant="outline" className="gap-1">
          <Loader2 className="size-3 animate-spin" /> {t('connecting')}
        </Badge>
      );
    default:
      return <Badge variant="outline">{t('notConnected')}</Badge>;
  }
}

function ChannelCard({
  channel,
  onChanged,
}: {
  channel: ChannelWithDetail;
  onChanged: () => void;
}) {
  const t = useTranslations('Settings.whatsapp.channels');
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(channel.label);
  const [saving, setSaving] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to update channel');
        return;
      }
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!confirm(t('removeConfirm'))) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/channels/${channel.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to remove channel');
        return;
      }
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  const detail =
    channel.provider === 'meta'
      ? channel.meta?.phone_number_id
      : channel.uazapi?.connected_phone || channel.uazapi?.instance_id;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            {editing ? (
              <Input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onBlur={() => {
                  setEditing(false);
                  if (label.trim() && label !== channel.label) patch({ label: label.trim() });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                className="h-7 max-w-48"
              />
            ) : (
              <span className="font-medium text-foreground">{channel.label}</span>
            )}
            <Badge variant="outline" className="uppercase">{channel.provider}</Badge>
            {channel.is_default && (
              <Badge variant="secondary" className="gap-1">
                <Star className="size-3" /> {t('default')}
              </Badge>
            )}
            {statusBadge(channel.status, t)}
          </div>
          {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="icon-sm" disabled={saving} onClick={() => setEditing(true)}>
            <Pencil className="size-4" />
          </Button>
          {!channel.is_default && (
            <Button variant="outline" size="sm" disabled={saving} onClick={() => patch({ is_default: true })}>
              {t('setDefault')}
            </Button>
          )}
          <Button
            variant="outline"
            size="icon-sm"
            disabled={saving}
            onClick={handleRemove}
            className="border-red-900 text-red-400 hover:bg-red-950/40"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ChannelsList() {
  const t = useTranslations('Settings.whatsapp');
  const tc = useTranslations('Settings.whatsapp.channels');
  const [channels, setChannels] = useState<ChannelWithDetail[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addStep, setAddStep] = useState<'choose' | 'meta' | 'uazapi'>('choose');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/channels');
      if (!res.ok) {
        toast.error(tc('loadFailed'));
        setChannels([]);
        return;
      }
      const data = await res.json();
      setChannels(data.channels ?? []);
    } catch {
      toast.error(tc('loadFailed'));
      setChannels([]);
    }
  }, [tc]);

  useEffect(() => {
    load();
  }, [load]);

  function closeAdd() {
    setAddOpen(false);
    setAddStep('choose');
    load();
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">{tc('heading')}</h3>
          <p className="text-xs text-muted-foreground">{tc('headingDesc')}</p>
        </div>
        <Button onClick={() => setAddOpen(true)} size="sm" className="gap-1.5">
          <Plus className="size-4" /> {tc('addChannel')}
        </Button>
      </div>

      {channels === null ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : channels.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {tc('empty')}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {channels.map((c) => (
            <ChannelCard key={c.id} channel={c} onChanged={load} />
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={(open) => (open ? setAddOpen(true) : closeAdd())}>
        <DialogContent className="sm:max-w-lg">
          {addStep === 'choose' && (
            <>
              <DialogHeader>
                <DialogTitle>{tc('chooseProvider')}</DialogTitle>
                <DialogDescription>{tc('chooseProviderDesc')}</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Card
                  className="cursor-pointer hover:border-primary"
                  onClick={() => setAddStep('meta')}
                >
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">{tc('providerMeta')}</CardTitle>
                    <p className="text-xs text-muted-foreground">{tc('providerMetaDesc')}</p>
                  </CardHeader>
                </Card>
                <Card
                  className="cursor-pointer hover:border-primary"
                  onClick={() => setAddStep('uazapi')}
                >
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">{tc('providerUazapi')}</CardTitle>
                    <p className="text-xs text-muted-foreground">{tc('providerUazapiDesc')}</p>
                  </CardHeader>
                </Card>
              </div>
            </>
          )}
          {addStep === 'meta' && <WhatsAppConfig />}
          {addStep === 'uazapi' && <UazapiChannelForm onConnected={closeAdd} />}
        </DialogContent>
      </Dialog>
    </section>
  );
}
```

- [ ] **Step 4: Wire the Settings page**

In `src/app/(dashboard)/settings/page.tsx`, replace:

```ts
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
```

with:

```ts
import { ChannelsList } from '@/components/settings/channels-list';
```

and replace:

```ts
    whatsapp: <WhatsAppConfig />,
```

with:

```ts
    whatsapp: <ChannelsList />,
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/channels-list.tsx src/components/settings/uazapi-channel-form.tsx "src/app/(dashboard)/settings/page.tsx" messages/en.json messages/pt-BR.json messages/ko.json
git commit -m "feat: replace single WhatsApp form with a channel list + add-channel dialog"
```

---

### Task 13: Settings UI — `UazapiChannelForm` (create + QR + poll)

**Files:**
- Modify: `src/components/settings/uazapi-channel-form.tsx` (replaces Task 12's stub entirely)
- Modify: `messages/en.json`, `messages/pt-BR.json`, `messages/ko.json` — add `Settings.whatsapp.channels.form.*`

**Interfaces:**
- Consumes: `POST /api/uazapi/instance`, `GET /api/uazapi/instance/[channelId]` (Task 8).

**Context:** Same "no component test convention" note as Task 12 — verify with `npm run typecheck` + manual smoke check. Flow: label + base URL inputs → "Create & Connect" → `POST /api/uazapi/instance` (returns `channelId` + initial `qrCode`) → render the QR (`<img src="data:image/png;base64,...">`, tolerant of the backend already including the `data:` prefix) → poll `GET /api/uazapi/instance/[channelId]` every 3s → on `status: 'connected'`, show success and call `onConnected()`; on `status: 'connecting'` with a new `qrCode`, swap the displayed image (UAZAPI QR codes expire); on `status: 'error'`, show the message and let the user retry from scratch. Poll stops after connecting or after a reasonable ceiling (2 minutes) with a manual "Check again" fallback, so a slow/unresponsive UAZAPI server can't leave an interval running forever.

- [ ] **Step 1: Add i18n keys**

Add a `form` object nested inside the `channels` object added in Task 12, in all three locale files.

`messages/en.json`:

```json
    "form": {
      "label": "Channel label",
      "labelPlaceholder": "e.g. Sales",
      "baseUrl": "UAZAPI server URL",
      "baseUrlPlaceholder": "https://your-server.uazapi.com",
      "create": "Create & Connect",
      "creating": "Creating…",
      "scanQr": "Scan this QR code with WhatsApp on your phone (Linked Devices → Link a Device).",
      "waitingForScan": "Waiting for scan…",
      "connected": "Connected as {phone}",
      "timedOut": "Still not connected. The QR code may have expired — try again.",
      "checkAgain": "Check again",
      "createFailed": "Failed to create the UAZAPI channel."
    }
```

`messages/pt-BR.json`:

```json
    "form": {
      "label": "Nome do canal",
      "labelPlaceholder": "ex.: Vendas",
      "baseUrl": "URL do servidor UAZAPI",
      "baseUrlPlaceholder": "https://seu-servidor.uazapi.com",
      "create": "Criar e conectar",
      "creating": "Criando…",
      "scanQr": "Escaneie este QR code com o WhatsApp do seu celular (Aparelhos conectados → Conectar um aparelho).",
      "waitingForScan": "Aguardando leitura…",
      "connected": "Conectado como {phone}",
      "timedOut": "Ainda não conectado. O QR code pode ter expirado — tente novamente.",
      "checkAgain": "Verificar novamente",
      "createFailed": "Falha ao criar o canal UAZAPI."
    }
```

`messages/ko.json`:

```json
    "form": {
      "label": "채널 이름",
      "labelPlaceholder": "예: 영업팀",
      "baseUrl": "UAZAPI 서버 URL",
      "baseUrlPlaceholder": "https://your-server.uazapi.com",
      "create": "생성 및 연결",
      "creating": "생성 중…",
      "scanQr": "휴대폰의 WhatsApp에서 이 QR 코드를 스캔하세요 (연결된 기기 → 기기 연결).",
      "waitingForScan": "스캔 대기 중…",
      "connected": "{phone}(으)로 연결됨",
      "timedOut": "아직 연결되지 않았습니다. QR 코드가 만료되었을 수 있습니다 — 다시 시도하세요.",
      "checkAgain": "다시 확인",
      "createFailed": "UAZAPI 채널 생성에 실패했습니다."
    }
```

- [ ] **Step 2: Write the implementation**

```tsx
// src/components/settings/uazapi-channel-form.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, CheckCircle2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

type Stage = 'form' | 'creating' | 'qr' | 'connected' | 'timed-out';

export function UazapiChannelForm({ onConnected }: { onConnected: () => void }) {
  const t = useTranslations('Settings.whatsapp.channels');
  const tf = useTranslations('Settings.whatsapp.channels.form');

  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [stage, setStage] = useState<Stage>('form');
  const [channelId, setChannelId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadline = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  async function pollOnce(id: string) {
    try {
      const res = await fetch(`/api/uazapi/instance/${id}`);
      const data = await res.json();
      if (data.status === 'connected') {
        stopPolling();
        setPhone(data.phone ?? null);
        setStage('connected');
        return;
      }
      if (data.status === 'error') {
        stopPolling();
        toast.error(data.message || tf('createFailed'));
        setStage('form');
        return;
      }
      if (data.qrCode) setQrCode(data.qrCode);
      if (Date.now() > pollDeadline.current) {
        stopPolling();
        setStage('timed-out');
      }
    } catch (err) {
      console.error('UAZAPI poll failed:', err);
    }
  }

  function startPolling(id: string) {
    pollDeadline.current = Date.now() + POLL_TIMEOUT_MS;
    stopPolling();
    pollTimer.current = setInterval(() => pollOnce(id), POLL_INTERVAL_MS);
  }

  async function handleCreate() {
    if (!label.trim() || !baseUrl.trim()) {
      toast.error('Fill in both fields');
      return;
    }
    setStage('creating');
    try {
      const res = await fetch('/api/uazapi/instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), base_url: baseUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || tf('createFailed'));
        setStage('form');
        return;
      }
      setChannelId(data.channelId);
      setQrCode(data.qrCode ?? null);
      setStage('qr');
      startPolling(data.channelId);
    } catch (err) {
      console.error('UAZAPI create failed:', err);
      toast.error(tf('createFailed'));
      setStage('form');
    }
  }

  function handleCheckAgain() {
    if (!channelId) return;
    setStage('qr');
    startPolling(channelId);
  }

  if (stage === 'connected') {
    return (
      <div className="space-y-4 py-2">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-emerald-400" />
            {tf('connected', { phone: phone ?? '' })}
          </DialogTitle>
        </DialogHeader>
        <Button onClick={onConnected} className="w-full">
          {t('addChannel')}
        </Button>
      </div>
    );
  }

  if (stage === 'qr' || stage === 'timed-out') {
    return (
      <div className="space-y-4 py-2">
        <DialogHeader>
          <DialogTitle>{tf('scanQr')}</DialogTitle>
        </DialogHeader>
        {qrCode && (
          <div className="flex justify-center">
            <img
              src={qrCode.startsWith('data:') ? qrCode : `data:image/png;base64,${qrCode}`}
              alt="QR code"
              className="size-56 rounded border border-border bg-white p-2"
            />
          </div>
        )}
        {stage === 'qr' ? (
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {tf('waitingForScan')}
          </p>
        ) : (
          <div className="space-y-2 text-center">
            <p className="text-sm text-amber-400">{tf('timedOut')}</p>
            <Button variant="outline" onClick={handleCheckAgain}>
              {tf('checkAgain')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 py-2">
      <DialogHeader>
        <DialogTitle>{t('providerUazapi')}</DialogTitle>
        <DialogDescription>{t('providerUazapiDesc')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label className="text-muted-foreground">{tf('label')}</Label>
        <Input
          placeholder={tf('labelPlaceholder')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-muted-foreground">{tf('baseUrl')}</Label>
        <Input
          placeholder={tf('baseUrlPlaceholder')}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
        />
      </div>
      <Button onClick={handleCreate} disabled={stage === 'creating'} className="w-full">
        {stage === 'creating' ? (
          <>
            <Loader2 className="size-4 animate-spin" /> {tf('creating')}
          </>
        ) : (
          tf('create')
        )}
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/uazapi-channel-form.tsx messages/en.json messages/pt-BR.json messages/ko.json
git commit -m "feat: add UAZAPI channel form with QR-code connect flow"
```

---

### Task 14: Final regression + spec status update

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-uazapi-provider-design.md:3`

**Steps:**

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: same pre-existing baseline failures as every prior plan in this series (`src/lib/currency.test.ts`, `src/lib/dashboard/date-utils.test.ts` — locale/timezone-dependent, unrelated to this plan), zero new failures.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS, zero errors.

- [ ] **Step 3: Update the spec status line**

In `docs/superpowers/specs/2026-08-10-uazapi-provider-design.md`, change line 3 from:

```
Status: Plano 3 (entrada/inbound) implementado
```

to:

```
Status: Plano 4 (provedor UAZAPI + UI de Settings) implementado
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-10-uazapi-provider-design.md
git commit -m "docs: mark plan 4 (UAZAPI provider + Settings UI) implemented"
```
