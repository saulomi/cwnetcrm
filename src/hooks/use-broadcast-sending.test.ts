// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBroadcastSending } from './use-broadcast-sending';
import type { Contact, MessageTemplate } from '@/types';

/**
 * This hook has no prior test coverage — it's a large (~600 line) hook
 * that resolves audience/custom-field data, inserts `broadcasts` +
 * `broadcast_recipients` rows, and calls `fetch`. Building full coverage
 * for it is out of scope for this task.
 *
 * This file is scoped narrowly to proving ONE thing: that
 * `payload.channelId` / `payload.sendDelayMs` reach (1) the `broadcasts`
 * insert row as `channel_id` / `send_delay_ms`, and (2) the
 * `/api/whatsapp/broadcast` POST body as `channel_id` / `send_delay_ms`.
 *
 * To do that we need `createAndSendBroadcast` to run to completion for
 * one simple 'all' audience / one recipient case, so the mock below is
 * the minimal surface that flow actually touches:
 *  - `supabase.auth.getSession()` (Step 0 — resolves the current user)
 *  - `supabase.from('contacts').select('*')` (Step 1 — 'all' audience)
 *  - `supabase.from('broadcasts').insert(...).select().single()` (Step 2)
 *  - `supabase.from('contact_custom_values').select(...).in(...)` (Step 3
 *    — custom-field index; empty is fine, no custom_field variables used)
 *  - `supabase.from('broadcast_recipients').insert(...)` (Step 3)
 *  - `supabase.from('broadcast_recipients').select(...).eq(...)` (Step 4)
 *  - `supabase.from('broadcast_recipients').update(...).eq(...)` (per-recipient
 *    status write-back after the fetch call)
 *  - `supabase.from('broadcasts').update(...).eq(...)` (Step 5 — finalize)
 *  - global `fetch` (the `/api/whatsapp/broadcast` POST)
 *
 * A single generic per-table chain stub covers all of this: `.select`,
 * `.insert`, `.update`, `.eq`, `.in`, `.single` all return the chain
 * (so arbitrary chaining works) and the chain itself is thenable,
 * resolving to a result picked by table name + which method was called.
 * `useAuth` is mocked directly rather than routed through the real
 * `AuthProvider`/context, since the hook only reads `accountId` off it.
 */

const CONTACT: Contact = {
  id: 'c1',
  user_id: 'user-1',
  account_id: 'acc-1',
  phone: '+15550001111',
  name: 'Alice',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const BROADCAST_ROW = {
  id: 'b1',
  user_id: 'user-1',
  account_id: 'acc-1',
};

const RECIPIENT_ROW = {
  id: 'r1',
  broadcast_id: 'b1',
  contact_id: 'c1',
  status: 'pending',
  template_params: [],
  contact: CONTACT,
};

const TEMPLATE: MessageTemplate = {
  id: 't1',
  user_id: 'user-1',
  name: 'welcome',
  category: 'Marketing',
  language: 'en_US',
  body_text: 'Hello',
  created_at: '2026-01-01T00:00:00.000Z',
};

const { broadcastsInsertSpy } = vi.hoisted(() => ({
  broadcastsInsertSpy: vi.fn(),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acc-1' }),
}));

vi.mock('@/lib/supabase/client', () => {
  // Generic chainable stub. Every builder method returns the same chain
  // object (so `.select().eq().in()` etc. all work regardless of order);
  // the chain is itself thenable, resolving to a table+method-specific
  // result. `.single()` resolves immediately since the real code awaits
  // it directly rather than the chain.
  function tableChain(table: string) {
    let result: { data: unknown; error: unknown } = { data: null, error: null };

    const chain: Record<string, unknown> = {};
    chain.select = () => {
      if (table === 'contacts') result = { data: [CONTACT], error: null };
      else if (table === 'contact_custom_values') result = { data: [], error: null };
      else if (table === 'broadcast_recipients')
        result = { data: [RECIPIENT_ROW], error: null };
      return chain;
    };
    chain.insert = (value: unknown) => {
      if (table === 'broadcasts') {
        broadcastsInsertSpy(value);
        result = { data: BROADCAST_ROW, error: null };
      } else if (table === 'broadcast_recipients') {
        result = { data: null, error: null };
      }
      return chain;
    };
    chain.update = () => {
      result = { data: null, error: null };
      return chain;
    };
    chain.eq = () => chain;
    chain.in = () => chain;
    chain.single = () => Promise.resolve(result);
    chain.then = (
      resolve: (value: typeof result) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return chain;
  }

  return {
    createClient: () => ({
      auth: {
        getSession: () =>
          Promise.resolve({ data: { session: { user: { id: 'user-1' } } } }),
      },
      from: (table: string) => tableChain(table),
    }),
  };
});

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const basePayload = {
  name: 'Test broadcast',
  template: TEMPLATE,
  audience: { type: 'all' as const },
  variables: {},
};

describe('useBroadcastSending — channelId / sendDelayMs threading', () => {
  beforeEach(() => {
    broadcastsInsertSpy.mockReset();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        results: [{ phone: CONTACT.phone, status: 'sent', whatsapp_message_id: 'wamid-1' }],
      }),
    });
  });

  it('persists channel_id and send_delay_ms on the broadcasts insert row', async () => {
    const { result } = renderHook(() => useBroadcastSending());

    await act(async () => {
      await result.current.createAndSendBroadcast({
        ...basePayload,
        channelId: 'ch-2',
        sendDelayMs: 400,
      });
    });

    expect(broadcastsInsertSpy).toHaveBeenCalledTimes(1);
    const insertedRow = broadcastsInsertSpy.mock.calls[0][0];
    expect(insertedRow).toMatchObject({
      channel_id: 'ch-2',
      send_delay_ms: 400,
    });
  });

  it('sends channel_id and send_delay_ms in the /api/whatsapp/broadcast POST body', async () => {
    const { result } = renderHook(() => useBroadcastSending());

    await act(async () => {
      await result.current.createAndSendBroadcast({
        ...basePayload,
        channelId: 'ch-2',
        sendDelayMs: 400,
      });
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/whatsapp/broadcast');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.channel_id).toBe('ch-2');
    expect(body.send_delay_ms).toBe(400);
  });

  it('omits channel_id/send_delay_ms from both the insert and the POST body when not provided', async () => {
    const { result } = renderHook(() => useBroadcastSending());

    await act(async () => {
      await result.current.createAndSendBroadcast({ ...basePayload });
    });

    const insertedRow = broadcastsInsertSpy.mock.calls[0][0];
    // Existing convention for optional fields on this insert (see
    // headerMediaUrl-adjacent fields) is "?? null", not omission —
    // match that rather than requiring the key be absent.
    expect(insertedRow.channel_id).toBeNull();
    expect(insertedRow.send_delay_ms).toBeNull();

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).not.toHaveProperty('channel_id');
    expect(body).not.toHaveProperty('send_delay_ms');
  });
});
