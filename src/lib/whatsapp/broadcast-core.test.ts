import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createBroadcast,
  deliverBroadcast,
  finalizeBroadcastStatus,
  BroadcastError,
} from './broadcast-core';
import type { BroadcastPlan } from './broadcast-core';
import type { WhatsAppProvider } from '@/lib/whatsapp/provider';

// Contact resolution and token decryption are exercised elsewhere — stub
// them so these tests focus on the persistence boundary.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}));

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// Build a Supabase-shaped mock that gets createBroadcast past its config +
// template lookups and into persistence. `rpcResult` is what the atomic
// create_broadcast_with_recipients RPC returns.
function makeDb(rpcResult: { data: unknown; error: unknown }) {
  const calls = {
    rpc: [] as { name: string; args: unknown }[],
    // Incremented if the OLD non-atomic path (a direct broadcasts /
    // broadcast_recipients insert) is ever reached — it must not be.
    usedDirectInsert: 0,
  };
  const database = {
    from(table: string) {
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
      if (table === 'message_templates') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        };
        return chain;
      }
      if (table === 'broadcasts' || table === 'broadcast_recipients') {
        calls.usedDirectInsert++;
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'orphan' }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(name: string, args: unknown) {
      calls.rpc.push({ name, args });
      return Promise.resolve(rpcResult);
    },
  } as unknown as SupabaseClient;
  return { db: database, calls };
}

describe('createBroadcast atomicity (#370)', () => {
  it('creates parent + recipients through the atomic RPC, never a bare parent insert', async () => {
    const { db, calls } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe('create_broadcast_with_recipients');
    expect(calls.usedDirectInsert).toBe(0);
    expect(plan.broadcastId).toBe('b-1');
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '14155550123', params: [] },
    ]);
  });

  it('throws and leaves no orphaned parent when the atomic create fails', async () => {
    const { db, calls } = makeDb({
      data: null,
      error: { message: 'recipient insert failed' },
    });

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toBeInstanceOf(BroadcastError);

    // The RPC was the only persistence attempt; because it runs both
    // inserts in a single transaction, its failure rolls the parent back —
    // there is no separate parent insert that could survive as an orphan.
    expect(calls.rpc).toHaveLength(1);
    expect(calls.usedDirectInsert).toBe(0);
  });
});

// ============================================================
// Terminal status (#472). Derived from the recipient rows, not from a
// counter local to one delivery pass — a resume only sends the
// leftovers, so "nothing sent this pass" must not condemn a campaign
// that already delivered hundreds.
// ============================================================

function statusDb(
  counts: Record<string, number>,
  total: number,
  writes: { update?: Record<string, unknown> },
) {
  return {
    from(table: string) {
      let status: string | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcasts') writes.update = row;
          return b;
        },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({
            count: status === null ? total : (counts[status] ?? 0),
            error: null,
          }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('finalizeBroadcastStatus', () => {
  it('leaves a capped pass in "sending" while recipients are still pending', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(statusDb({ pending: 25 }, 1025, writes), 'b-1');
    // No write at all — the UI keeps offering Resume.
    expect(writes.update).toBeUndefined();
  });

  it('marks a fully-failed broadcast failed', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 10 }, 10, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('failed');
  });

  it('marks a partially-failed broadcast sent', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 3 }, 10, writes),
      'b-1',
    );
    // 7 people got the message; failed_count carries the other 3.
    expect(writes.update?.status).toBe('sent');
  });

  it('does not condemn a campaign whose resume pass sent nothing new', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    // 800 delivered on the original pass, the 200-recipient resume all
    // failed. Pre-fix this wrote 'failed' off a pass-local counter.
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 200 }, 1000, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('sent');
  });
});

// ============================================================
// deliverBroadcast pacing (delayMs). No prior coverage of
// deliverBroadcast existed in this file — this builds its own
// `db`/`provider` mocks from scratch, following the chainable-stub
// convention used by `statusDb` above and by
// channel-resolution.test.ts (an object whose methods return itself
// until a terminal method/`then` resolves a promise).
// ============================================================

function makeDeliverDb() {
  const recipientUpdates: Array<{ id: string; row: Record<string, unknown> }> = [];
  const database = {
    from(table: string) {
      if (table === 'broadcast_recipients') {
        // Doubles as (a) the per-recipient `.update(...).eq('id', ...)`
        // deliverBroadcast issues, and (b) the count queries
        // finalizeBroadcastStatus issues afterwards (`.select(...).eq(...)`,
        // resolved via `then` since these tests don't assert on status
        // derivation — that's covered by the `finalizeBroadcastStatus`
        // suite above).
        const chain: Record<string, unknown> = {
          update: (row: Record<string, unknown>) => ({
            eq: (_col: string, val: string) => {
              recipientUpdates.push({ id: val, row });
              return Promise.resolve({ data: null, error: null });
            },
          }),
          select: () => chain,
          eq: () => chain,
          then: (resolve: (r: { count: number; error: null }) => unknown) =>
            resolve({ count: 0, error: null }),
        };
        return chain;
      }
      if (table === 'broadcasts') {
        return {
          update: () => ({
            eq: () => Promise.resolve({ data: null, error: null }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
  return { db: database, recipientUpdates };
}

function makePlan(overrides: Partial<BroadcastPlan> = {}): BroadcastPlan {
  const provider = {
    sendTemplate: vi.fn().mockResolvedValue({ messageId: 'm1' }),
  } as unknown as WhatsAppProvider;
  return {
    broadcastId: 'b-1',
    templateName: 'promo',
    templateLanguage: 'en_US',
    channelId: 'ch-1',
    provider,
    templateRow: null,
    planned: [
      { recipientRowId: 'r-1', phone: '14155550123', params: [] },
      { recipientRowId: 'r-2', phone: '14155550124', params: [] },
    ],
    rejected: 0,
    ...overrides,
  };
}

describe('deliverBroadcast pacing (delayMs)', () => {
  it('sleeps delayMs between each recipient send when set on the plan', async () => {
    vi.useFakeTimers();
    const { db } = makeDeliverDb();
    const plan = makePlan({ delayMs: 500 });

    const deliverPromise = deliverBroadcast(db, plan);
    await vi.advanceTimersByTimeAsync(0); // let the first send fire
    expect(plan.provider.sendTemplate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500); // the pacing delay
    await deliverPromise;
    expect(plan.provider.sendTemplate).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not delay when delayMs is unset (existing behavior)', async () => {
    const { db } = makeDeliverDb();
    const plan = makePlan();

    // No fake timers here at all — if deliverBroadcast waited on
    // anything, this would hang until the test's own timeout instead
    // of resolving.
    await deliverBroadcast(db, plan);
    expect(plan.provider.sendTemplate).toHaveBeenCalledTimes(2);
  });
});
