# UAZAPI Provider — Plan 5: Multi-Channel Routing UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the multi-channel routing that Plans 1-4 already built at the data/backend layer into every UI surface that sends a message — inbox composer, broadcast wizard, and Flows/Automations "send message" steps — plus a per-broadcast UAZAPI send-pacing control, closing the last gap of the original 5-plan decomposition.

**Architecture:** No new abstraction layer. Every surface already resolves its channel server-side via `resolveChannelForSend`/`resolveProvider` (`src/lib/whatsapp/channel-resolution.ts`, unchanged) — this plan only adds the missing UI to *see* and *override* that resolution, plus one new persisted field (`broadcasts.channel_id` / `broadcasts.send_delay_ms`) and one shared `useChannels()` hook + `<ChannelSelect>` component so the four UI surfaces (inbox, broadcasts, flows, automations) don't each hand-roll a fetch of `/api/channels`.

**Tech Stack:** Same as Plans 1-4 — Next.js App Router, Supabase (Postgres + RLS), TypeScript, Vitest, next-intl (en/pt-BR/ko), shadcn `Select`/`Dialog` components.

**Spec:** `docs/superpowers/specs/2026-08-10-uazapi-provider-design.md` (sections "Escolha de canal (roteamento)" — this plan implements every UI bullet under it that Plans 1-4 left undone).

## Global Constraints

- Zero behavior change for an existing single-channel Meta account, except two deliberate fixes: the inbox "WhatsApp not connected" banner now checks `channels` (any provider) instead of the Meta-only `whatsapp_config` compat view, and a resumed broadcast now reuses the channel/delay the original send used instead of silently falling back to the account default.
- Every new column is nullable and defaults to `NULL`/unset — no backfill required, no existing row's behavior changes.
- One shared `useChannels()` hook (`src/hooks/use-channels.ts`) and one shared `<ChannelSelect>` component (`src/components/whatsapp/channel-select.tsx`) back every channel picker in this plan. Do not add a second ad-hoc `fetch('/api/channels')` anywhere.
- `db`-as-first-param convention for every server-side helper (matches Plans 1-4).
- All new user-facing strings go into `messages/en.json`, `messages/pt-BR.json`, and `messages/ko.json` — real translations for pt-BR/ko (not English copies), matching each file's existing tone for the surrounding keys.
- Routing precedence, everywhere a step-level/broadcast-level override is introduced: **explicit override → `conversation.channel_id` (if applicable) → account `is_default` channel → error if ambiguous.** This is `resolveChannelForSend`'s existing signature (`conversationChannelId` param) — an override is passed into that same parameter slot, never a new resolution path.
- No new migration touches `channels`, `meta_channels`, or `uazapi_channels` — those are frozen since Plan 1. New migration only adds columns to `broadcasts`.
- `npm run typecheck` and the full `npx vitest run` suite must pass at every task boundary (same pre-existing baseline failures as Plans 1-4 — `src/lib/currency.test.ts`, `src/lib/dashboard/date-utils.test.ts` — are expected and not regressions).

---

## File Structure

**New files:**
- `supabase/migrations/041_broadcast_channel.sql` — `broadcasts.channel_id`, `broadcasts.send_delay_ms`.
- `src/hooks/use-channels.ts` — shared `useChannels()` hook wrapping `GET /api/channels`.
- `src/components/whatsapp/channel-select.tsx` — shared `<ChannelSelect>` presentational component.
- `src/hooks/use-channels.test.ts`, `src/components/whatsapp/channel-select.test.tsx`.

**Modified files (by area):**

*Inbox:*
- `src/types/index.ts` — `Conversation.channel_id` field.
- `src/app/(dashboard)/inbox/page.tsx` — connection-banner query fix.
- `src/components/inbox/message-thread.tsx` — channel badge + switcher.

*Broadcasts:*
- `src/lib/whatsapp/broadcast-core.ts` — `BroadcastPlan.delayMs`, `deliverBroadcast` pacing.
- `src/lib/whatsapp/broadcast-resume.ts` — reuse persisted `channel_id`/`send_delay_ms`.
- `src/app/api/whatsapp/broadcast/route.ts` — accept + apply `send_delay_ms`.
- `src/hooks/use-broadcast-sending.ts` — persist + send `channel_id`/`send_delay_ms`.
- `src/components/broadcasts/step4-schedule-send.tsx` — channel selector + delay input + warning.
- `src/app/(dashboard)/broadcasts/new/page.tsx` — thread the new state through.

*Flows:*
- `src/lib/flows/types.ts` — `SendMessageNodeConfig.channel_id`.
- `src/lib/flows/meta-send.ts` — `SendTextEngineArgs.channelId`.
- `src/lib/flows/engine.ts` — pass `cfg.channel_id` through.
- `src/components/flows/forms/node-config-form.tsx` — channel select on `send_message`.

*Automations:*
- `src/types/index.ts` — `SendMessageStepConfig.channel_id`.
- `src/lib/automations/meta-send.ts` — `SendTextArgs.channelId`.
- `src/lib/automations/engine.ts` — pass `cfg.channel_id` through.
- `src/components/automations/automation-builder.tsx` — channel select on `send_message`.

*Docs:*
- `docs/superpowers/specs/2026-08-10-uazapi-provider-design.md` — status line.

---

## Interfaces (frozen — every task below must match exactly)

```ts
// src/hooks/use-channels.ts
export function useChannels(): {
  channels: Channel[] | null; // null while loading; [] if none/errored
  loading: boolean;
  reload: () => void;
};

// src/components/whatsapp/channel-select.tsx
export interface ChannelSelectProps {
  channels: Channel[];
  /** null = "use account default" (only meaningful when allowDefault). */
  value: string | null;
  onChange: (channelId: string | null) => void;
  /** Shows a "Account default" option that emits null. Default false. */
  allowDefault?: boolean;
  /** Only offer channels with status === 'connected'. Default true. */
  connectedOnly?: boolean;
  placeholder?: string;
  className?: string;
}
```

```ts
// src/lib/whatsapp/broadcast-core.ts — BroadcastPlan gains:
export interface BroadcastPlan {
  // ...existing fields unchanged...
  /** ms to sleep between each recipient send. undefined = no pacing. */
  delayMs?: number;
}
```

```ts
// src/lib/flows/types.ts
export interface SendMessageNodeConfig {
  text: string;
  next_node_key: string;
  /** Explicit channel override. Unset = normal routing rule. */
  channel_id?: string | null;
}

// src/lib/flows/meta-send.ts — SendTextEngineArgs gains:
interface SendTextEngineArgs {
  // ...existing fields unchanged...
  channelId?: string | null;
}
```

```ts
// src/types/index.ts
export interface SendMessageStepConfig {
  text: string;
  channel_id?: string | null;
}
export interface Conversation {
  // ...existing fields unchanged...
  channel_id?: string | null;
}

// src/lib/automations/meta-send.ts — SendTextArgs gains:
interface SendTextArgs {
  // ...existing fields unchanged...
  channelId?: string | null;
}
```

---

### Task 1: `broadcasts.channel_id` + `send_delay_ms` migration

**Files:**
- Create: `supabase/migrations/041_broadcast_channel.sql`

**Interfaces:**
- Produces: `broadcasts.channel_id UUID NULL REFERENCES channels(id)`, `broadcasts.send_delay_ms INTEGER NULL`.

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- 041_broadcast_channel
--
-- Plan 5 (multi-channel routing UI). Two columns on `broadcasts`:
--
--   1. `channel_id` — which channel this campaign was sent through.
--      NULL means "resolved to the account default at send time"
--      (every broadcast before this migration). Lets a resumed pass
--      (broadcast-resume.ts) reuse the exact channel the original
--      pass used instead of re-resolving against the account's
--      *current* default, which may have changed since.
--
--   2. `send_delay_ms` — optional pacing between individual sends.
--      UAZAPI is an unofficial API; sending a large batch back-to-back
--      risks the number getting flagged/banned. NULL means "no
--      artificial delay" (Meta's official API needs none).
--
-- Both nullable, no backfill, no default — every existing row keeps
-- today's behavior (resolve channel fresh, no delay) exactly.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id) ON DELETE SET NULL;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS send_delay_ms INTEGER;

COMMENT ON COLUMN broadcasts.channel_id IS
  'Channel this campaign sends through. NULL = resolve the account default at send time (pre-Plan-5 behavior).';

COMMENT ON COLUMN broadcasts.send_delay_ms IS
  'Optional ms delay between individual recipient sends. NULL = no delay. Mainly for UAZAPI channels to avoid volume-triggered bans.';
```

- [ ] **Step 2: Apply and verify**

Run: `node scripts/apply-migration.mjs supabase/migrations/041_broadcast_channel.sql` (requires `$env:DATABASE_URL` set — if no live DB is reachable in this environment, skip execution and note it in the task report; the SQL itself is reviewed for correctness, matching the exact idempotent `ADD COLUMN IF NOT EXISTS` pattern of migrations 038-040).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/041_broadcast_channel.sql
git commit -m "feat(db): add broadcasts.channel_id and send_delay_ms"
```

---

### Task 2: `useChannels()` hook

**Files:**
- Create: `src/hooks/use-channels.ts`
- Test: `src/hooks/use-channels.test.ts`

**Interfaces:**
- Consumes: `GET /api/channels` → `{ channels: Channel[] }` (existing route, `src/app/api/channels/route.ts`, unchanged).
- Produces: `useChannels(): { channels: Channel[] | null; loading: boolean; reload: () => void }` (frozen interface above). Every later task in this plan consumes this hook.

- [ ] **Step 1: Write the failing test**

```ts
// src/hooks/use-channels.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useChannels } from './use-channels';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('useChannels', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('starts loading with channels null, then resolves', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        channels: [
          { id: 'ch-1', account_id: 'acc-1', provider: 'meta', label: 'Sales', status: 'connected', is_default: true, created_at: '', updated_at: '' },
        ],
      }),
    });
    const { result } = renderHook(() => useChannels());
    expect(result.current.loading).toBe(true);
    expect(result.current.channels).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.channels).toHaveLength(1);
    expect(result.current.channels?.[0].id).toBe('ch-1');
  });

  it('resolves to an empty array on a failed request rather than staying null', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    const { result } = renderHook(() => useChannels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.channels).toEqual([]);
  });

  it('reload() re-fetches', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ channels: [] }),
    });
    const { result } = renderHook(() => useChannels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    result.current.reload();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/use-channels.test.ts`
Expected: FAIL — `use-channels.ts` does not exist yet (`Cannot find module './use-channels'`).

- [ ] **Step 3: Write the implementation**

```ts
// src/hooks/use-channels.ts
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Channel } from '@/types';

/**
 * Shared fetch of the caller's account WhatsApp channels
 * (`GET /api/channels`), used by every channel picker in the app —
 * inbox badge/switcher, broadcast wizard, Flows/Automations
 * send_message step config. One fetch implementation so those four
 * surfaces can't drift on error handling or response shape.
 */
export function useChannels() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/channels');
      if (!res.ok) {
        setChannels([]);
        return;
      }
      const data = await res.json();
      setChannels(data.channels ?? []);
    } catch {
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadTick]);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  return { channels, loading, reload };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/use-channels.test.ts`
Expected: PASS (3/3). If `@testing-library/react`'s `renderHook`/`waitFor` are not already a project dependency, check `package.json` first — the codebase's other hook tests (e.g. any existing `src/hooks/*.test.ts`) show the established pattern; match it exactly (import path and test-environment config) rather than introducing a new one.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-channels.ts src/hooks/use-channels.test.ts
git commit -m "feat: add shared useChannels hook"
```

---

### Task 3: `<ChannelSelect>` shared component

**Files:**
- Create: `src/components/whatsapp/channel-select.tsx`
- Test: `src/components/whatsapp/channel-select.test.tsx`

**Interfaces:**
- Consumes: `Channel` type (`@/types`), shadcn `Select`/`SelectContent`/`SelectItem`/`SelectTrigger`/`SelectValue` (`@/components/ui/select`, same import Plan 4's `channels-list.tsx` and Flows' `fields.tsx` already use).
- Produces: `<ChannelSelect>` per the frozen `ChannelSelectProps` interface above. Every UI task after this one renders it.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/whatsapp/channel-select.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChannelSelect } from './channel-select';
import type { Channel } from '@/types';

const channels: Channel[] = [
  { id: 'ch-1', account_id: 'a', provider: 'meta', label: 'Sales', status: 'connected', is_default: true, created_at: '', updated_at: '' },
  { id: 'ch-2', account_id: 'a', provider: 'uazapi', label: 'Support', status: 'connected', is_default: false, created_at: '', updated_at: '' },
  { id: 'ch-3', account_id: 'a', provider: 'uazapi', label: 'Stale', status: 'disconnected', is_default: false, created_at: '', updated_at: '' },
];

describe('ChannelSelect', () => {
  it('lists only connected channels by default', () => {
    render(<ChannelSelect channels={channels} value={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByText('Sales')).toBeInTheDocument();
    expect(screen.getByText('Support')).toBeInTheDocument();
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
  });

  it('includes disconnected channels when connectedOnly=false', () => {
    render(<ChannelSelect channels={channels} value={null} onChange={vi.fn()} connectedOnly={false} />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByText('Stale')).toBeInTheDocument();
  });

  it('shows an "account default" option only when allowDefault is set, and emits null for it', () => {
    const onChange = vi.fn();
    render(<ChannelSelect channels={channels} value={null} onChange={onChange} allowDefault />);
    fireEvent.click(screen.getByRole('combobox'));
    const defaultOption = screen.getByText('__default__');
    fireEvent.click(defaultOption);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('emits the channel id when a real channel is picked', () => {
    const onChange = vi.fn();
    render(<ChannelSelect channels={channels} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('Support'));
    expect(onChange).toHaveBeenCalledWith('ch-2');
  });
});
```

Note: the `'__default__'` text assertion above stands in for whatever the real `t('accountDefault')` string resolves to under the test's i18n setup — check how existing component tests in this codebase handle `next-intl`'s `useTranslations` in a test environment (e.g. `src/components/settings/channels-list.tsx`'s sibling test, if one exists, or any other `.test.tsx` that renders a component using `useTranslations`) and match that mocking convention exactly rather than inventing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/whatsapp/channel-select.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```tsx
// src/components/whatsapp/channel-select.tsx
'use client';

import { useTranslations } from 'next-intl';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { Channel } from '@/types';

const DEFAULT_SENTINEL = '__account_default__';

export interface ChannelSelectProps {
  channels: Channel[];
  value: string | null;
  onChange: (channelId: string | null) => void;
  allowDefault?: boolean;
  connectedOnly?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * Shared channel picker — inbox badge/switcher, broadcast wizard,
 * Flows/Automations send_message step config all render this instead
 * of hand-rolling a Select over `useChannels()`'s result.
 */
export function ChannelSelect({
  channels,
  value,
  onChange,
  allowDefault = false,
  connectedOnly = true,
  placeholder,
  className,
}: ChannelSelectProps) {
  const t = useTranslations('WhatsappChannels');
  const options = connectedOnly
    ? channels.filter((c) => c.status === 'connected')
    : channels;

  return (
    <Select
      value={value ?? DEFAULT_SENTINEL}
      onValueChange={(v) => onChange(v === DEFAULT_SENTINEL ? null : v)}
    >
      <SelectTrigger className={cn('bg-muted', className)}>
        <SelectValue placeholder={placeholder ?? t('selectChannel')} />
      </SelectTrigger>
      <SelectContent>
        {allowDefault && (
          <SelectItem value={DEFAULT_SENTINEL}>{t('accountDefault')}</SelectItem>
        )}
        {options.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.label} ({c.provider})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

- [ ] **Step 4: Add i18n keys**

Add to `messages/en.json` under a new top-level `"WhatsappChannels"` key (sibling to `"Settings"`, `"Inbox"`, etc.):

```json
"WhatsappChannels": {
  "selectChannel": "Select a channel",
  "accountDefault": "Account default"
}
```

Add matching real translations to `messages/pt-BR.json`:

```json
"WhatsappChannels": {
  "selectChannel": "Selecionar um canal",
  "accountDefault": "Padrão da conta"
}
```

And `messages/ko.json`:

```json
"WhatsappChannels": {
  "selectChannel": "채널 선택",
  "accountDefault": "계정 기본값"
}
```

Insert each block alphabetically among the existing top-level keys in that file (check where `"Settings"` and `"WhatsApp..."`-adjacent keys sit in each file and place it consistently across all three — the parity test in `src/i18n/messages.test.ts` only checks key coverage, not ordering, but keep the files easy to diff).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/components/whatsapp/channel-select.test.tsx src/i18n/messages.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/whatsapp/channel-select.tsx src/components/whatsapp/channel-select.test.tsx messages/en.json messages/pt-BR.json messages/ko.json
git commit -m "feat: add shared ChannelSelect component"
```

---

### Task 4: Fix inbox's Meta-only "WhatsApp connected" banner check

**Files:**
- Modify: `src/app/(dashboard)/inbox/page.tsx:175-213` (the `checkConnection` effect)

**Interfaces:**
- Consumes: `channels` table (`id`, `status`, `account_id` — same table `resolve-conversation.ts`'s Task 5 fix from Plan 4 already reads).

- [ ] **Step 1: Read the current effect**

Confirm the exact block at `src/app/(dashboard)/inbox/page.tsx:175-213` still matches what's quoted in this plan's investigation (the query at line 203-207 selecting `whatsapp_config.status`). If it has drifted, adapt this task's diff to the real current text — same class of judgment call Plan 4's implementers made when a brief's quoted snippet didn't match byte-for-byte.

- [ ] **Step 2: Replace the query**

Replace:

```ts
      const { data } = await supabase
        .from("whatsapp_config")
        .select("status")
        .eq("account_id", accountId)
        .maybeSingle();

      setWhatsappConnected(data?.status === "connected");
```

with:

```ts
      // Any provider counts — whatsapp_config only ever reflected the
      // Meta channel, so a UAZAPI-only account always saw this banner
      // even while fully connected (same bug class fixed in
      // resolve-conversation.ts by Plan 4's Task 5).
      const { data } = await supabase
        .from("channels")
        .select("status")
        .eq("account_id", accountId);

      setWhatsappConnected((data ?? []).some((c) => c.status === "connected"));
```

Update the comment block above this effect (lines 186-191, "whatsapp_config is one-row-per-account...") to describe the new query instead of the old one — keep the existing note about resolving `account_id` via the profile (that part is unchanged and still correct), drop the now-inaccurate claim that `whatsapp_config` is the source.

- [ ] **Step 3: Manual verification**

This effect has no existing unit test (it's a `useEffect` inside a page component with a live Supabase client, not mocked at this layer per the codebase's existing test coverage for this file — check `src/app/(dashboard)/inbox/page.tsx`'s sibling `.test.tsx` if one exists; if none exists, this is consistent with the rest of that file's untested client-side effects, and this task doesn't introduce a new test file for it, matching that established pattern). Verify with `npx tsc --noEmit` that the query result type still narrows correctly (no `.single()`/`.maybeSingle()` used now, `data` is an array).

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/inbox/page.tsx"
git commit -m "fix: inbox connected-banner checks any provider, not just Meta"
```

---

### Task 5: Channel badge + switcher on the inbox thread

**Files:**
- Modify: `src/types/index.ts` (`Conversation` interface, around line 160-184)
- Modify: `src/components/inbox/message-thread.tsx`
- Test: `src/components/inbox/message-thread.test.tsx` (create if none exists for this file; if one already exists, extend it)

**Interfaces:**
- Consumes: `useChannels()` (Task 2), `Channel` type, `conversation.channel_id` (added this task).
- Produces: nothing consumed by later tasks — this is a leaf UI task.

- [ ] **Step 1: Add `channel_id` to the `Conversation` type**

In `src/types/index.ts`, inside `export interface Conversation { ... }` (around line 160), add:

```ts
  /**
   * Channel this conversation is pinned to (migration 039/040's
   * conversations.channel_id). null = resolves to the account's
   * default channel at send time. Set automatically to whichever
   * channel most recently delivered an inbound message from this
   * contact (inbound-processor.ts); can be changed manually here.
   */
  channel_id?: string | null;
```

`CONVERSATION_SELECT` (`src/lib/inbox/conversations.ts:10`) already selects `"*"`, so this column is already fetched — no query change needed, only the type.

- [ ] **Step 2: Find the thread header render site**

Read `src/components/inbox/message-thread.tsx` around its header/toolbar area (near where `AiThreadBanner` and the assignment dropdown are rendered, roughly lines 1150-1195 per this plan's investigation — confirm the exact current line numbers before editing, they may have shifted). Identify where a small badge row (channel badge, alongside any existing status/assignment badges) fits without disrupting the existing layout.

- [ ] **Step 3: Add the badge + switcher**

Add near the top of the component:

```tsx
import { useChannels } from '@/hooks/use-channels';
import { ChannelSelect } from '@/components/whatsapp/channel-select';
```

Inside the component body (near other `useState`/hook calls):

```tsx
  const { channels } = useChannels();
  const activeChannel =
    channels?.find((c) => c.id === conversation.channel_id) ??
    channels?.find((c) => c.is_default) ??
    null;

  const handleChannelSwitch = useCallback(
    async (channelId: string | null) => {
      if (!channelId || !conversation) return;
      const supabase = createClient();
      const { error } = await supabase
        .from('conversations')
        .update({ channel_id: channelId })
        .eq('id', conversation.id);
      if (error) {
        toast.error('Failed to switch channel');
        return;
      }
      // Optimistic local reflect — parent's realtime subscription will
      // also pick this up, but that round-trip shouldn't gate the UI.
      onUpdateConversation?.({ channel_id: channelId });
    },
    [conversation, onUpdateConversation],
  );
```

Check the component's actual prop list for whether an `onUpdateConversation`-shaped callback already exists (e.g. the existing `onAssignChange` prop used by `AiThreadBanner` at line ~1178-1182 is the established pattern for "child mutates a conversation field, tell the parent"). If no generic update callback exists, add one following that exact same shape/convention (prop name and signature consistent with `onAssignChange`), and wire it in the parent (`inbox/page.tsx`) the same way `onAssignChange` is already wired, rather than inventing a different plumbing mechanism.

Render, near the existing badges (only when `channels` has loaded and has at least one channel — hide entirely for an account still mid-migration with zero channels, which shouldn't happen post-Plan-1 but is a safe guard):

```tsx
      {channels && channels.length > 1 && (
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-xs">
            {activeChannel ? `${activeChannel.label} (${activeChannel.provider})` : '—'}
          </Badge>
          <ChannelSelect
            channels={channels}
            value={conversation.channel_id ?? null}
            onChange={handleChannelSwitch}
            className="h-6 w-auto text-xs"
          />
        </div>
      )}
```

The `channels.length > 1` guard is deliberate: a single-channel account (today's common case) gets zero new UI — the badge/switcher only appears once there's actually something to switch between, matching the spec's framing that this is multi-channel-only surface area.

- [ ] **Step 4: Write a test for the switch handler**

```tsx
// src/components/inbox/message-thread.test.tsx (add this describe block;
// if the file doesn't exist yet, check whether message-thread.tsx has
// other existing coverage elsewhere before deciding to create a full
// new test file for what is otherwise an untested component — if this
// is the first test for the file, keep it scoped to exactly this
// behavior rather than attempting full coverage.)
import { describe, it, expect, vi } from 'vitest';

// Mock useChannels to return two connected channels.
vi.mock('@/hooks/use-channels', () => ({
  useChannels: () => ({
    channels: [
      { id: 'ch-1', account_id: 'a', provider: 'meta', label: 'Sales', status: 'connected', is_default: true, created_at: '', updated_at: '' },
      { id: 'ch-2', account_id: 'a', provider: 'uazapi', label: 'Support', status: 'connected', is_default: false, created_at: '', updated_at: '' },
    ],
    loading: false,
    reload: vi.fn(),
  }),
}));

describe('message-thread channel switcher', () => {
  it('shows the badge/switcher only when the account has 2+ channels', () => {
    // Render with the mocked 2-channel useChannels above; assert the
    // channel badge text is present. Match this file's existing
    // rendering setup (providers/wrappers) for message-thread.tsx —
    // check how other tests in this codebase render components that
    // depend on next-intl + Supabase client mocks, and reuse that
    // harness rather than building a new one.
  });
});
```

Fill in the actual render + assertion once the exact existing test harness conventions for this component are confirmed (per the note above) — this is the one step in this plan where the concrete test body depends on infrastructure this plan's author could not fully verify without a live run; the implementer must complete it following codebase precedent, not skip it.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/components/inbox/message-thread.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: clean (same pre-existing baseline failures only).

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/components/inbox/message-thread.tsx src/components/inbox/message-thread.test.tsx
git commit -m "feat: show active channel badge + switcher in the inbox thread"
```

---

### Task 6: `broadcast-core.ts` — pacing support in `deliverBroadcast`

**Files:**
- Modify: `src/lib/whatsapp/broadcast-core.ts`
- Modify: `src/lib/whatsapp/broadcast-core.test.ts` (extend existing)

**Interfaces:**
- Produces: `BroadcastPlan.delayMs?: number` (frozen interface above) — consumed by Task 7 (`broadcast-resume.ts`).

- [ ] **Step 1: Write the failing test**

Add to the existing `broadcast-core.test.ts` (check its existing mocking setup for `deliverBroadcast` and match it exactly — it already mocks `plan.provider.sendTemplate` and the `db` client):

```ts
it('sleeps delayMs between each recipient send when set on the plan', async () => {
  vi.useFakeTimers();
  const sleepSpy = vi.fn();
  // ... construct a plan with 2 `planned` recipients and `delayMs: 500`,
  // a provider.sendTemplate mock that resolves immediately, and a db
  // mock whose `.update()` resolves immediately (matching this file's
  // existing db mock shape) ...

  const deliverPromise = deliverBroadcast(db, plan);
  await vi.advanceTimersByTimeAsync(0); // let the first send fire
  expect(plan.provider.sendTemplate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500); // the pacing delay
  await deliverPromise;
  expect(plan.provider.sendTemplate).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it('does not delay when delayMs is unset (existing behavior)', async () => {
  // Construct a plan WITHOUT delayMs, 2 recipients, assert
  // deliverBroadcast resolves without needing any fake-timer advance —
  // proves this task doesn't slow down the existing no-delay path.
});
```

Fill in the mock scaffolding using this test file's own existing helpers (it already has a working `db`/`provider` mock setup for `deliverBroadcast` from Plans 1-4 era tests — reuse it, don't rebuild it).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/broadcast-core.test.ts`
Expected: FAIL — no delay behavior exists yet.

- [ ] **Step 3: Implement the pacing**

In `src/lib/whatsapp/broadcast-core.ts`, add near the top (module scope):

```ts
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

Add `delayMs?: number;` to the `BroadcastPlan` interface (per the frozen Interfaces section).

In `deliverBroadcast`'s `for (const recipient of plan.planned)` loop (around line 266), after the per-recipient DB update block (the `if (sentMessageId) { ... } else { ... }` at lines 291-309) and before the loop's closing brace, add:

```ts
    if (plan.delayMs && plan.delayMs > 0) {
      await sleep(plan.delayMs);
    }
```

Placing it at the end of each iteration (not before the first send) means a 1-recipient broadcast never pays the delay, and an N-recipient broadcast pays it N-1 times in spirit (the last iteration's sleep is wasted but harmless — simpler than special-casing the final index, and `deliverBroadcast`'s caller awaits the whole function anyway so the trailing sleep just adds `delayMs` to a value nothing is racing against).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/broadcast-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/broadcast-core.ts src/lib/whatsapp/broadcast-core.test.ts
git commit -m "feat: deliverBroadcast paces sends when plan.delayMs is set"
```

---

### Task 7: `broadcast-resume.ts` — reuse the original channel + delay

**Files:**
- Modify: `src/lib/whatsapp/broadcast-resume.ts:151-256`
- Modify: `src/lib/whatsapp/broadcast-resume.test.ts` (extend existing)

**Interfaces:**
- Consumes: `broadcasts.channel_id`, `broadcasts.send_delay_ms` (Task 1), `BroadcastPlan.delayMs` (Task 6).

- [ ] **Step 1: Write the failing test**

Add to the existing `broadcast-resume.test.ts` (match its existing `db` mock/fixture conventions):

```ts
it('resolves the channel the original broadcast used, not the current account default', async () => {
  // Fixture: broadcasts row has channel_id: 'ch-original'. Account's
  // CURRENT default channel is a different id, 'ch-new-default'. Spy
  // on resolveChannelForSend (or assert via its mocked db calls) that
  // it was invoked with 'ch-original', not null.
});

it('carries send_delay_ms from the broadcast row onto the returned plan', async () => {
  // Fixture: broadcasts row has send_delay_ms: 750. Assert
  // planBroadcastResume(...).plan.delayMs === 750.
});

it('still resolves the account default when the original broadcast has no channel_id (pre-Plan-5 rows)', async () => {
  // Fixture: channel_id: null. Assert resolveChannelForSend was
  // called with null (unchanged pre-Plan-5 behavior) and
  // plan.delayMs is undefined.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/whatsapp/broadcast-resume.test.ts`
Expected: FAIL on the first two new tests.

- [ ] **Step 3: Implement**

In `src/lib/whatsapp/broadcast-resume.ts`, change the `broadcasts` select at line 153:

```ts
    .select('id, template_name, template_language')
```

to:

```ts
    .select('id, template_name, template_language, channel_id, send_delay_ms')
```

Change the `resolveChannelForSend` call at line 215:

```ts
    resolvedChannel = await resolveChannelForSend(db, accountId, null);
```

to:

```ts
    resolvedChannel = await resolveChannelForSend(db, accountId, broadcast.channel_id ?? null);
```

And in the `plan` object construction (around line 238-253), add:

```ts
    delayMs: broadcast.send_delay_ms ?? undefined,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/whatsapp/broadcast-resume.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/broadcast-resume.ts src/lib/whatsapp/broadcast-resume.test.ts
git commit -m "fix: broadcast resume reuses the original channel and send delay"
```

---

### Task 8: `/api/whatsapp/broadcast` route — accept + apply `send_delay_ms`

**Files:**
- Modify: `src/app/api/whatsapp/broadcast/route.ts`
- Modify: `src/app/api/whatsapp/broadcast/route.test.ts` (extend existing)

**Interfaces:**
- Consumes: request body's new optional `send_delay_ms: number` field.

- [ ] **Step 1: Write the failing test**

```ts
it('sleeps send_delay_ms between recipients when provided', async () => {
  vi.useFakeTimers();
  // POST with 2 recipients and send_delay_ms: 300; mock provider.sendTemplate
  // to resolve immediately; assert the response only resolves after
  // advancing fake timers by 300ms, and that sendTemplate was called
  // twice. Match this file's existing request/response mock harness.
  vi.useRealTimers();
});

it('does not delay when send_delay_ms is omitted (existing behavior unchanged)', async () => {
  // Existing-shape test, no delay field, assert no timer advance needed.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/broadcast/route.test.ts`

- [ ] **Step 3: Implement**

In `src/app/api/whatsapp/broadcast/route.ts`, add near the top:

```ts
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
```

Destructure the new field alongside the existing ones (around line 85-92):

```ts
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      channel_id,
      send_delay_ms,
    } = body
```

In the `for (const recipient of recipients)` loop (around line 169), after the existing `if (sentMessageId) { ... } else { ... }` result-push block and before the loop's closing brace, add:

```ts
      if (typeof send_delay_ms === 'number' && send_delay_ms > 0) {
        await sleep(send_delay_ms)
      }
```

Same trailing-sleep-on-last-iteration tradeoff as Task 6, deliberately — this route is the client-driven wizard's per-batch call, and batches are already capped small (`SEND_BATCH_SIZE` in `use-broadcast-sending.ts`), so the wasted tail sleep per batch is negligible.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/whatsapp/broadcast/route.test.ts`

- [ ] **Step 5: Run full suite + typecheck**

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/broadcast/route.ts src/app/api/whatsapp/broadcast/route.test.ts
git commit -m "feat: broadcast route paces sends via optional send_delay_ms"
```

---

### Task 9: `use-broadcast-sending.ts` — persist + send channel/delay

**Files:**
- Modify: `src/hooks/use-broadcast-sending.ts`
- Modify: `src/hooks/use-broadcast-sending.test.ts` (extend existing)

**Interfaces:**
- Consumes: nothing new.
- Produces: `BroadcastPayload.channelId?: string | null`, `BroadcastPayload.sendDelayMs?: number` — consumed by Task 11 (the page component).

- [ ] **Step 1: Write the failing test**

```ts
it('persists channel_id and send_delay_ms on the broadcasts insert row', async () => {
  // Call createAndSendBroadcast with { ...basePayload, channelId: 'ch-2', sendDelayMs: 400 }.
  // Assert the mocked supabase.from('broadcasts').insert(...) call
  // received { channel_id: 'ch-2', send_delay_ms: 400, ... } among its fields.
});

it('sends channel_id and send_delay_ms in the /api/whatsapp/broadcast POST body', async () => {
  // Same setup; assert the mocked fetch('/api/whatsapp/broadcast', ...)
  // call's body JSON includes channel_id: 'ch-2' and send_delay_ms: 400.
});

it('omits channel_id/send_delay_ms from both the insert and the POST body when not provided (unchanged default)', async () => {
  // Call without channelId/sendDelayMs; assert neither key appears
  // (or appears as null/undefined per whatever this file's existing
  // convention is for optional fields — match it).
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/use-broadcast-sending.test.ts`

- [ ] **Step 3: Implement**

Add to `BroadcastPayload` (around line 41-53):

```ts
  /** Explicit channel to send through. undefined = account default. */
  channelId?: string | null;
  /** ms delay between individual sends (mainly for UAZAPI pacing). */
  sendDelayMs?: number;
```

In the `broadcasts` insert (around line 366-389), add:

```ts
          channel_id: payload.channelId ?? null,
          send_delay_ms: payload.sendDelayMs ?? null,
```

In the `/api/whatsapp/broadcast` POST body construction (around line 502-506), add:

```ts
              body: JSON.stringify({
                recipients: apiRecipients,
                template_name: payload.template.name,
                template_language: payload.template.language ?? 'en_US',
                channel_id: payload.channelId ?? undefined,
                send_delay_ms: payload.sendDelayMs ?? undefined,
              }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/use-broadcast-sending.test.ts`

- [ ] **Step 5: Run full suite + typecheck**

- [ ] **Step 6: Commit**

```bash
git add src/hooks/use-broadcast-sending.ts src/hooks/use-broadcast-sending.test.ts
git commit -m "feat: thread channel_id and send_delay_ms through broadcast sending"
```

---

### Task 10: Broadcast wizard UI — channel selector + delay input + UAZAPI warning

**Files:**
- Modify: `src/components/broadcasts/step4-schedule-send.tsx`
- Test: `src/components/broadcasts/step4-schedule-send.test.tsx` (create if none exists)

**Interfaces:**
- Consumes: `useChannels()` (Task 2), `<ChannelSelect>` (Task 3).
- Produces: two new callback props consumed by Task 11.

- [ ] **Step 1: Extend props**

Add to `Step4Props` (around line 26-36):

```ts
  channelId: string | null;
  onChannelIdChange: (id: string | null) => void;
  sendDelayMs: number | null;
  onSendDelayMsChange: (ms: number | null) => void;
```

- [ ] **Step 2: Render the picker + warning**

Add imports:

```tsx
import { useChannels } from '@/hooks/use-channels';
import { ChannelSelect } from '@/components/whatsapp/channel-select';
```

Inside the component, after destructuring the new props:

```tsx
  const { channels } = useChannels();
  const connectedChannels = (channels ?? []).filter((c) => c.status === 'connected');
  const selectedChannel = connectedChannels.find((c) => c.id === channelId) ?? null;
  const isUazapi = selectedChannel?.provider === 'uazapi';

  // Single connected channel: pre-select it, no picker friction (spec:
  // "com 1 único canal conectado, é pré-selecionado sem fricção extra
  // visível"). Runs once channels finish loading and nothing is
  // selected yet — never overrides a user's explicit choice.
  useEffect(() => {
    if (!channelId && connectedChannels.length === 1) {
      onChannelIdChange(connectedChannels[0].id);
    }
  }, [channelId, connectedChannels, onChannelIdChange]);
```

Add a new block in the JSX, inside the "Summary Card" section (after the existing `grid grid-cols-2` block, around line 144, still inside the same `space-y-3` card) — only rendered once there's something to choose between:

```tsx
        {connectedChannels.length > 1 && (
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">{t('scheduleSend.channel')}</p>
            <ChannelSelect
              channels={connectedChannels}
              value={channelId}
              onChange={onChannelIdChange}
              className="w-full"
            />
          </div>
        )}
```

Add a second block, right after it, only for a UAZAPI selection:

```tsx
        {isUazapi && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <p>{t('scheduleSend.uazapiWarning')}</p>
            <label className="mt-2 flex items-center gap-2">
              {t('scheduleSend.delayLabel')}
              <Input
                type="number"
                min={0}
                step={100}
                value={sendDelayMs ?? ''}
                onChange={(e) =>
                  onSendDelayMsChange(e.target.value === '' ? null : Number(e.target.value))
                }
                className="h-7 w-24 border-border bg-muted text-foreground"
              />
              {t('scheduleSend.delayUnit')}
            </label>
          </div>
        )}
```

- [ ] **Step 3: Add i18n keys**

Add under the existing `"Broadcasts.wizard.scheduleSend"` object in `messages/en.json` (alongside `"title"`, `"subtitle"`, etc.):

```json
"channel": "Send from",
"uazapiWarning": "This channel uses an unofficial WhatsApp connection. Sending many messages back-to-back risks the number getting flagged. Consider adding a delay between sends.",
"delayLabel": "Delay between sends",
"delayUnit": "ms"
```

Add matching real translations to `messages/pt-BR.json` under the equivalent `"Broadcasts.wizard.scheduleSend"` object:

```json
"channel": "Enviar de",
"uazapiWarning": "Este canal usa uma conexão não oficial do WhatsApp. Enviar muitas mensagens seguidas arrisca o número ser sinalizado. Considere adicionar um intervalo entre os envios.",
"delayLabel": "Intervalo entre envios",
"delayUnit": "ms"
```

And `messages/ko.json`:

```json
"channel": "발신 채널",
"uazapiWarning": "이 채널은 비공식 WhatsApp 연결을 사용합니다. 메시지를 연속으로 많이 보내면 번호가 차단될 위험이 있습니다. 발송 간 지연을 추가하는 것을 고려하세요.",
"delayLabel": "발송 간 지연",
"delayUnit": "ms"
```

- [ ] **Step 4: Write a test**

```tsx
// src/components/broadcasts/step4-schedule-send.test.tsx
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/hooks/use-channels', () => ({
  useChannels: () => ({
    channels: [
      { id: 'ch-meta', account_id: 'a', provider: 'meta', label: 'Sales', status: 'connected', is_default: true, created_at: '', updated_at: '' },
      { id: 'ch-uazapi', account_id: 'a', provider: 'uazapi', label: 'Support', status: 'connected', is_default: false, created_at: '', updated_at: '' },
    ],
    loading: false,
    reload: vi.fn(),
  }),
}));

describe('Step4ScheduleSend channel picker', () => {
  it('shows the UAZAPI warning + delay input only when a uazapi channel is selected', () => {
    // Render with channelId='ch-uazapi', assert warning text + delay
    // input present. Re-render (or a second test) with channelId='ch-meta',
    // assert both are absent. Match this component's existing render
    // setup conventions (next-intl provider wrapper, etc.) from any
    // sibling test in src/components/broadcasts/, or from step1-4's own
    // test coverage if it exists — check before writing a new harness.
  });

  it('auto-selects the only connected channel when nothing is chosen yet', () => {
    // Mock useChannels to return exactly ONE connected channel; render
    // with channelId=null and an onChannelIdChange spy; assert the spy
    // was called with that channel's id.
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/components/broadcasts/step4-schedule-send.test.tsx src/i18n/messages.test.ts`

- [ ] **Step 6: Run full suite + typecheck**

- [ ] **Step 7: Commit**

```bash
git add src/components/broadcasts/step4-schedule-send.tsx src/components/broadcasts/step4-schedule-send.test.tsx messages/en.json messages/pt-BR.json messages/ko.json
git commit -m "feat: channel picker + UAZAPI rate-limit warning in broadcast wizard"
```

---

### Task 11: Wire channel/delay state through the broadcast wizard page

**Files:**
- Modify: `src/app/(dashboard)/broadcasts/new/page.tsx`

**Interfaces:**
- Consumes: `Step4Props`'s new fields (Task 10), `BroadcastPayload.channelId`/`sendDelayMs` (Task 9).

- [ ] **Step 1: Add state**

Near the existing `useState` calls (around line 46-47):

```tsx
  const [channelId, setChannelId] = useState<string | null>(null);
  const [sendDelayMs, setSendDelayMs] = useState<number | null>(null);
```

- [ ] **Step 2: Thread into `handleSend`**

In `handleSend` (around line 49-74), add to the `createAndSendBroadcast` call:

```tsx
      const broadcastId = await createAndSendBroadcast({
        name,
        template,
        audience: { /* unchanged */ },
        variables,
        headerMediaUrl,
        channelId,
        sendDelayMs: sendDelayMs ?? undefined,
      });
```

- [ ] **Step 3: Thread into `handleSaveDraft`**

In the `broadcasts` insert inside `handleSaveDraft` (around line 104-122), add:

```tsx
      channel_id: channelId,
      send_delay_ms: sendDelayMs,
```

- [ ] **Step 4: Pass props to `Step4ScheduleSend`**

Find the `<Step4ScheduleSend ... />` render call (further down in the file, not shown in this plan's excerpted read — locate it via the existing `template`/`audience`/`onSend` props already passed) and add:

```tsx
            channelId={channelId}
            onChannelIdChange={setChannelId}
            sendDelayMs={sendDelayMs}
            onSendDelayMsChange={setSendDelayMs}
```

- [ ] **Step 5: Run full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: clean — this task has no new test file (it's prop-threading through an existing page component with no prior test coverage for this file, consistent with that file's current state).

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/broadcasts/new/page.tsx"
git commit -m "feat: wire channel + delay selection through the broadcast wizard page"
```

---

### Task 12: Flows — optional channel override on `send_message`

**Files:**
- Modify: `src/lib/flows/types.ts:30-35`
- Modify: `src/lib/flows/meta-send.ts:35-45,92-99`
- Modify: `src/lib/flows/engine.ts:614-623`
- Modify: `src/lib/flows/meta-send.test.ts` (extend existing), `src/lib/flows/engine.test.ts` (extend existing)

**Interfaces:**
- Produces: `SendMessageNodeConfig.channel_id` (frozen above) — consumed by Task 13.

- [ ] **Step 1: Write the failing test (meta-send.ts)**

Add to `src/lib/flows/meta-send.test.ts` (match its existing `db`/provider mock conventions for `engineSendText`):

```ts
it('resolves the explicit channelId ahead of the conversation channel when both are set', async () => {
  // Fixture: conversation.channel_id = 'ch-conv'; call engineSendText
  // with channelId: 'ch-override'. Assert resolveChannelForSend (or
  // whatever this test's existing mock exposes for inspection) was
  // called with 'ch-override', not 'ch-conv'.
});

it('falls back to the conversation channel when channelId is not given (unchanged behavior)', async () => {
  // No channelId passed; assert resolveChannelForSend was called with
  // conversation.channel_id, exactly as before this task.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/flows/meta-send.test.ts`

- [ ] **Step 3: Implement in `meta-send.ts`**

Add to `SendTextEngineArgs` (around line 35-45):

```ts
  /** Explicit channel override — takes priority over the conversation's
   *  pinned channel. Set from the send_message node's config. */
  channelId?: string | null
```

Change the `resolveChannelForSend` call (around line 95-99) from:

```ts
    resolvedChannel = await resolveChannelForSend(
      db,
      args.accountId,
      conversation?.channel_id
    )
```

to:

```ts
    resolvedChannel = await resolveChannelForSend(
      db,
      args.accountId,
      args.channelId ?? conversation?.channel_id
    )
```

- [ ] **Step 4: Update `types.ts`**

In `src/lib/flows/types.ts`, add to `SendMessageNodeConfig` (per the frozen Interfaces section):

```ts
  /** Explicit channel override. Unset = normal routing rule. */
  channel_id?: string | null;
```

- [ ] **Step 5: Update `engine.ts`**

In the `send_message` branch (around line 614-623), change:

```ts
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
```

to:

```ts
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
          channelId: cfg.channel_id,
        });
```

(Leave the two other `engineSendText` call sites in this file — `collect_input`'s prompt send and re-send-on-invalid-input, around lines 675-681 and 1055-1061 — untouched. Only `send_message` nodes get the override, per this plan's scope; `collect_input` has no `channel_id` field on its config and this task doesn't add one.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/flows/meta-send.test.ts src/lib/flows/engine.test.ts`

- [ ] **Step 7: Run full suite + typecheck**

- [ ] **Step 8: Commit**

```bash
git add src/lib/flows/types.ts src/lib/flows/meta-send.ts src/lib/flows/engine.ts src/lib/flows/meta-send.test.ts src/lib/flows/engine.test.ts
git commit -m "feat: send_message flow node supports an explicit channel override"
```

---

### Task 13: Flows UI — channel select on `send_message`

**Files:**
- Modify: `src/components/flows/forms/node-config-form.tsx:80-96`
- Test: `src/components/flows/forms/node-config-form.test.tsx` (create if none exists; check first)

**Interfaces:**
- Consumes: `useChannels()`, `<ChannelSelect allowDefault>` (Tasks 2-3), `SendMessageNodeConfig.channel_id` (Task 12).

- [ ] **Step 1: Add the picker to the `send_message` case**

In `src/components/flows/forms/node-config-form.tsx`, add imports:

```tsx
import { useChannels } from "@/hooks/use-channels";
import { ChannelSelect } from "@/components/whatsapp/channel-select";
```

Change the `case "send_message":` branch (lines 80-96) from:

```tsx
    case "send_message":
      return (
        <>
          <TextRow
            label={t("textToCustomer")}
            value={(cfg as { text?: string }).text ?? ""}
            onChange={(v) => onUpdateConfig({ text: v })}
          />
          <NextNodeRow
            value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ next_node_key: v })}
            label={t("advancesTo")}
          />
        </>
      );
```

to:

```tsx
    case "send_message":
      return (
        <>
          <TextRow
            label={t("textToCustomer")}
            value={(cfg as { text?: string }).text ?? ""}
            onChange={(v) => onUpdateConfig({ text: v })}
          />
          <SendMessageChannelRow
            value={(cfg as { channel_id?: string | null }).channel_id ?? null}
            onChange={(v) => onUpdateConfig({ channel_id: v })}
            label={t("channelOverride")}
          />
          <NextNodeRow
            value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ next_node_key: v })}
            label={t("advancesTo")}
          />
        </>
      );
```

Add a small local component near the bottom of this file (same file — mirrors how `SendButtonsForm`/`SendListForm` are also defined locally in this file rather than in `fields.tsx`, since they're single-use):

```tsx
function SendMessageChannelRow({
  value,
  onChange,
  label,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  label: string;
}) {
  const { channels } = useChannels();
  if (!channels || channels.length < 2) return null; // nothing to override with
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <ChannelSelect
        channels={channels}
        value={value}
        onChange={onChange}
        allowDefault
        className="bg-muted"
      />
    </div>
  );
}
```

- [ ] **Step 2: Add i18n key**

Add to `messages/en.json` under `"Flows.builder.form"` (alongside the existing `"textToCustomer"`, `"advancesTo"`, `"pickNextNode"`, `"none"` keys):

```json
"channelOverride": "Send via (optional)"
```

Add to `messages/pt-BR.json` under the equivalent `"Flows.builder.form"` object:

```json
"channelOverride": "Enviar por (opcional)"
```

And `messages/ko.json`:

```json
"channelOverride": "발신 채널 (선택 사항)"
```

- [ ] **Step 3: Write a test**

```tsx
// src/components/flows/forms/node-config-form.test.tsx
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/hooks/use-channels', () => ({
  useChannels: () => ({
    channels: [
      { id: 'ch-1', account_id: 'a', provider: 'meta', label: 'Sales', status: 'connected', is_default: true, created_at: '', updated_at: '' },
      { id: 'ch-2', account_id: 'a', provider: 'uazapi', label: 'Support', status: 'connected', is_default: false, created_at: '', updated_at: '' },
    ],
    loading: false,
    reload: vi.fn(),
  }),
}));

describe('NodeConfigForm send_message channel override', () => {
  it('calls onUpdateConfig with channel_id when a channel is picked', () => {
    // Render <NodeConfigForm node={{ node_type: 'send_message', config: { text: '', next_node_key: '' }, node_key: 'n1' }} allNodes={[]} showAdvanced={false} onUpdateConfig={spy} />,
    // open the channel select, pick 'Support', assert spy called with { channel_id: 'ch-2' }.
    // Match this codebase's existing test setup for node-config-form.tsx
    // if one already exists (check src/components/flows/forms/ for a
    // sibling test file first) rather than inventing new render helpers.
  });

  it('renders nothing for the channel row when the account has fewer than 2 channels', () => {
    // Re-mock useChannels to return a single channel; assert the
    // "channelOverride" label is not present.
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/flows/forms/node-config-form.test.tsx src/i18n/messages.test.ts`

- [ ] **Step 5: Run full suite + typecheck**

- [ ] **Step 6: Commit**

```bash
git add src/components/flows/forms/node-config-form.tsx src/components/flows/forms/node-config-form.test.tsx messages/en.json messages/pt-BR.json messages/ko.json
git commit -m "feat: optional channel override picker on the send_message flow node"
```

---

### Task 14: Automations — optional channel override on `send_message`

**Files:**
- Modify: `src/types/index.ts:536-538`
- Modify: `src/lib/automations/meta-send.ts:34-46,150-156`
- Modify: `src/lib/automations/engine.ts:362-376`
- Modify: `src/lib/automations/meta-send.test.ts` (extend existing), `src/lib/automations/engine.test.ts` (extend existing)

**Interfaces:**
- Produces: `SendMessageStepConfig.channel_id` (frozen above) — consumed by Task 15.

- [ ] **Step 1: Write the failing test (meta-send.ts)**

Same shape as Task 12's Step 1, adapted to `src/lib/automations/meta-send.test.ts`'s existing `engineSendText`/`sendViaMeta` mock conventions — two tests: explicit `channelId` wins over `conversation?.channel_id`; omitted `channelId` falls back unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/automations/meta-send.test.ts`

- [ ] **Step 3: Update `types.ts`**

In `src/types/index.ts`, change (line 536-538):

```ts
export interface SendMessageStepConfig {
  text: string;
}
```

to:

```ts
export interface SendMessageStepConfig {
  text: string;
  /** Explicit channel override. Unset = normal routing rule. */
  channel_id?: string | null;
}
```

- [ ] **Step 4: Implement in `meta-send.ts`**

Add to `SendTextArgs` (around line 34-46):

```ts
  /** Explicit channel override — takes priority over the conversation's
   *  pinned channel. Set from the send_message step's config. */
  channelId?: string | null
```

Change the `resolveChannelForSend` call (around line 151-155) from:

```ts
    resolvedChannel = await resolveChannelForSend(
      db,
      input.accountId,
      conversation?.channel_id
    )
```

to:

```ts
    resolvedChannel = await resolveChannelForSend(
      db,
      input.accountId,
      input.channelId ?? conversation?.channel_id
    )
```

Note `SendInput` is a union (`SendTextArgs & {kind:'text'} | SendTemplateArgs & {kind:'template'}`) — `channelId` needs adding to both `SendTextArgs` AND `SendTemplateArgs` (they're separate interfaces in this file, unlike Flows' single `SendTextEngineArgs`) so `sendViaMeta`'s `input.channelId` is valid for either kind. This plan's scope is `send_message` only (which uses `engineSendText`/`SendTextArgs`), but `sendViaMeta` is the shared internal implementation for both — add the field to `SendTemplateArgs` too for type consistency even though `engineSendTemplate`'s public signature isn't otherwise touched by this task.

- [ ] **Step 5: Update `engine.ts`**

In the `send_message` case (around line 362-376), change:

```ts
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
```

to:

```ts
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
        channelId: cfg.channel_id,
      })
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/automations/meta-send.test.ts src/lib/automations/engine.test.ts`

- [ ] **Step 7: Run full suite + typecheck**

- [ ] **Step 8: Commit**

```bash
git add src/types/index.ts src/lib/automations/meta-send.ts src/lib/automations/engine.ts src/lib/automations/meta-send.test.ts src/lib/automations/engine.test.ts
git commit -m "feat: send_message automation step supports an explicit channel override"
```

---

### Task 15: Automations UI — channel select on `send_message`

**Files:**
- Modify: `src/components/automations/automation-builder.tsx:1306-1316`
- Test: `src/components/automations/automation-builder.test.tsx` (extend existing if present; create scoped test otherwise)

**Interfaces:**
- Consumes: `useChannels()`, `<ChannelSelect allowDefault>` (Tasks 2-3), `SendMessageStepConfig.channel_id` (Task 14).

- [ ] **Step 1: Add the picker**

Add imports near the top of `automation-builder.tsx`:

```tsx
import { useChannels } from "@/hooks/use-channels"
import { ChannelSelect } from "@/components/whatsapp/channel-select"
```

Change the `case "send_message":` branch (lines 1306-1316) from:

```tsx
    case "send_message":
      return (
        <FieldBlock label={t("config.messageText")}>
          <Textarea
            value={(cfg.text as string) ?? ""}
            onChange={(e) => set({ text: e.target.value })}
            placeholder={t("config.placeholderMessageText")}
            className="min-h-24 bg-muted text-foreground"
          />
        </FieldBlock>
      )
```

to:

```tsx
    case "send_message":
      return (
        <>
          <FieldBlock label={t("config.messageText")}>
            <Textarea
              value={(cfg.text as string) ?? ""}
              onChange={(e) => set({ text: e.target.value })}
              placeholder={t("config.placeholderMessageText")}
              className="min-h-24 bg-muted text-foreground"
            />
          </FieldBlock>
          <SendMessageChannelField
            value={(cfg.channel_id as string | null) ?? null}
            onChange={(v) => set({ channel_id: v })}
            label={t("config.channelOverride")}
          />
        </>
      )
```

Add a local component near this file's other small helpers (check where `SendTemplateFields` or similar single-use sub-components are defined in this file and place it alongside them, matching the existing style):

```tsx
function SendMessageChannelField({
  value,
  onChange,
  label,
}: {
  value: string | null
  onChange: (v: string | null) => void
  label: string
}) {
  const { channels } = useChannels()
  if (!channels || channels.length < 2) return null
  return (
    <FieldBlock label={label}>
      <ChannelSelect channels={channels} value={value} onChange={onChange} allowDefault />
    </FieldBlock>
  )
}
```

(`FieldBlock` is already imported/used elsewhere in this file for the `messageText` field above — reuse it rather than hand-rolling a new label wrapper.)

- [ ] **Step 2: Add i18n key**

Add to `messages/en.json` under `"Automations.builder.config"` (alongside `"messageText"`, `"placeholderMessageText"`):

```json
"channelOverride": "Send via (optional)"
```

Add matching real translations to `messages/pt-BR.json` and `messages/ko.json` under the equivalent `"Automations.builder.config"` object — same strings as Task 13's Flows equivalent (`"Enviar por (opcional)"` / `"발신 채널 (선택 사항)"`), since it's the identical concept in a sibling engine; keep the English source identical too for consistency between the two builders.

- [ ] **Step 3: Write a test**

Same shape as Task 13's Step 3, adapted to `automation-builder.tsx`'s step-config editing entry point (`step.step_config` / `onChange(step)` pattern instead of Flows' `node.config` / `onUpdateConfig(patch)`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/automations/automation-builder.test.tsx src/i18n/messages.test.ts`

- [ ] **Step 5: Run full suite + typecheck**

- [ ] **Step 6: Commit**

```bash
git add src/components/automations/automation-builder.tsx src/components/automations/automation-builder.test.tsx messages/en.json messages/pt-BR.json messages/ko.json
git commit -m "feat: optional channel override picker on the send_message automation step"
```

---

### Task 16: Final regression + spec doc status update

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-uazapi-provider-design.md:3`

**Interfaces:** none.

- [ ] **Step 1: Run the full suite**

Run: `npx vitest run`
Expected: same pre-existing baseline failures only (`src/lib/currency.test.ts`, `src/lib/dashboard/date-utils.test.ts`), zero new regressions across all 16 tasks' changes combined.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Update the spec doc status line**

Change line 3 of `docs/superpowers/specs/2026-08-10-uazapi-provider-design.md` from:

```
Status: Plano 4 (provedor UAZAPI + UI de Settings) implementado
```

to:

```
Status: Plano 5 (UI de roteamento multi-canal) implementado — decomposição de 5 planos completa
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-10-uazapi-provider-design.md
git commit -m "docs: mark plan 5 (multi-channel routing UI) implemented"
```

---

## Self-Review Notes

**Spec coverage:** Every bullet under the spec's "Escolha de canal (roteamento)" section now has a task — inbox composer badge/switch (Tasks 4-5), Flows/Automations optional channel field (Tasks 12-15), broadcast mandatory-in-practice channel field with single-channel auto-select (Tasks 9-11), UAZAPI broadcast rate-limit + UI warning (Tasks 6, 8, 10). The "conversa é única por contato" and "nenhuma coluna existente é removida" decisions from the spec are structural constraints already satisfied by Plans 1-4's schema — no new task needed for them.

**Deliberately out of scope (unchanged from the spec's own "Fora de escopo (v1)" section):** WhatsApp groups, UAZAPI catalog/business-profile, per-channel conversation splitting, non-Meta/UAZAPI providers. Also out of scope for *this* plan specifically: extending the channel override to `collect_input`/`send_buttons`/`send_list` node types (Task 12 deliberately scopes to `send_message` only, matching the spec's literal wording) and the public v1 broadcast API (`broadcast-core.ts`'s `createBroadcast`) gaining its own channel/delay parameters — only the already-existing `deliverBroadcast`/resume path picks up pacing, since the public API has no UI to expose a picker in and wasn't named in the spec's UI section.
