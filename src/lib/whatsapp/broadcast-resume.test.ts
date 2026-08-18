import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BroadcastError } from './broadcast-core';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
  MAX_RESUME_DELAY_MS,
  RESUME_MAX_PER_REQUEST,
  RESUME_TIME_BUDGET_MS,
} from './broadcast-resume';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

// ============================================================
// Claim / release — the mutex that stops a double-send.
// ============================================================

interface ClaimCall {
  update: Record<string, unknown>;
  filters: Record<string, unknown>;
  or?: string;
}

function claimDb(returnedRows: unknown[], calls: ClaimCall[]): SupabaseClient {
  return {
    from() {
      const call: ClaimCall = { update: {}, filters: {} };
      const b: Record<string, unknown> = {
        update: (row: Record<string, unknown>) => {
          call.update = row;
          calls.push(call);
          return b;
        },
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return b;
        },
        or: (expr: string) => {
          call.or = expr;
          return b;
        },
        select: async () => ({ data: returnedRows, error: null }),
        then: (resolve: (r: { error: null }) => unknown) =>
          resolve({ error: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('claimBroadcastDelivery', () => {
  it('claims when the conditional UPDATE matched a row', async () => {
    const calls: ClaimCall[] = [];
    const ok = await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );

    expect(ok).toBe(true);
    expect(calls[0].filters).toEqual({ id: 'bc-1', account_id: 'acct-1' });
    expect(calls[0].update.delivery_locked_at).toBe(
      '2026-08-11T12:00:00.000Z',
    );
  });

  it('refuses when another pass already holds the lock', async () => {
    // The UPDATE's WHERE didn't match — someone else got there first.
    const ok = await claimBroadcastDelivery(
      claimDb([], []),
      'acct-1',
      'bc-1',
    );
    expect(ok).toBe(false);
  });

  it('treats a lock older than the staleness window as abandoned', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );
    // 30 minutes before "now" — a pass whose process died is recoverable
    // without touching the database by hand.
    expect(calls[0].or).toBe(
      'delivery_locked_at.is.null,delivery_locked_at.lt.2026-08-11T11:30:00.000Z',
    );
  });

  it('is scoped to the account, so another tenant cannot claim it', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(claimDb([], calls), 'acct-9', 'bc-1');
    expect(calls[0].filters.account_id).toBe('acct-9');
  });
});

describe('releaseBroadcastDelivery', () => {
  it('clears the lock', async () => {
    const calls: ClaimCall[] = [];
    await releaseBroadcastDelivery(claimDb([], calls), 'bc-1');
    expect(calls[0].update).toEqual({ delivery_locked_at: null });
    expect(calls[0].filters).toEqual({ id: 'bc-1' });
  });
});

// ============================================================
// Planning — which recipients a pass picks up, and with what params.
// ============================================================

interface PlanFixture {
  broadcast?: Record<string, unknown> | null;
  recipients?: Record<string, unknown>[];
  channel?: Record<string, unknown> | null;
  metaChannel?: Record<string, unknown> | null;
  templates?: Record<string, unknown>[];
}

interface PlanWrites {
  statusFilter?: unknown;
  failedIds?: unknown;
  failedUpdate?: Record<string, unknown>;
  /** The `id` a `channels` lookup was filtered on, if any — lets tests
   * see which channel `resolveChannelForSend` was actually asked to
   * resolve, distinct from the `is_default` fallback branch. */
  channelIdQueried?: unknown;
}

function planDb(fx: PlanFixture, writes: PlanWrites = {}): SupabaseClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (table === 'channels' && col === 'id') writes.channelIdQueried = val;
          return b;
        },
        order: () => b,
        in: (col: string, vals: unknown) => {
          if (col === 'status') writes.statusFilter = vals;
          if (col === 'id') writes.failedIds = vals;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          writes.failedUpdate = row;
          return b;
        },
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
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
          if (table === 'broadcast_recipients') {
            return resolve({ data: fx.recipients ?? [], error: null });
          }
          if (table === 'message_templates') {
            return resolve({ data: fx.templates ?? [], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const BROADCAST = {
  id: 'bc-1',
  template_name: 'order_update',
  template_language: 'en_US',
};

const CHANNEL = { id: 'ch-1', provider: 'meta' as const };
const META_CHANNEL = { id: 'mc-1', phone_number_id: 'pn-1', access_token: 'tok' };

function recipient(
  id: string,
  phone: string | null,
  params: unknown = ['A123'],
) {
  return {
    id,
    template_params: params,
    contact: phone ? { phone } : null,
  };
}

describe('planBroadcastResume', () => {
  it('plans the outstanding recipients with their frozen params', async () => {
    const writes: PlanWrites = {};
    const { plan, remaining, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          channel: CHANNEL,
          metaChannel: META_CHANNEL,
          recipients: [
            recipient('r1', '+15551234567', ['A123', 'Friday']),
            recipient('r2', '+15559876543', ['B456', 'Monday']),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(writes.statusFilter).toEqual(['pending']);
    // Phones are stored sanitized (no leading '+'), same as the shape
    // createBroadcast plans — deliverBroadcast feeds them to
    // phoneVariants from here.
    expect(plan.planned).toEqual([
      {
        recipientRowId: 'r1',
        phone: '15551234567',
        params: ['A123', 'Friday'],
      },
      {
        recipientRowId: 'r2',
        phone: '15559876543',
        params: ['B456', 'Monday'],
      },
    ]);
    expect(plan.channelId).toBe('ch-1');
    expect(remaining).toBe(0);
    expect(unsendable).toBe(0);
  });

  it('scopes to failed rows when retrying, and to both for "all"', async () => {
    const failedWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          channel: CHANNEL,
          metaChannel: META_CHANNEL,
          recipients: [recipient('r1', '+15551234567')],
        },
        failedWrites,
      ),
      'acct-1',
      'bc-1',
      'failed',
    );
    expect(failedWrites.statusFilter).toEqual(['failed']);

    const allWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          channel: CHANNEL,
          metaChannel: META_CHANNEL,
          recipients: [recipient('r1', '+15551234567')],
        },
        allWrites,
      ),
      'acct-1',
      'bc-1',
      'all',
    );
    expect(allWrites.statusFilter).toEqual(['pending', 'failed']);
  });

  it('treats a missing or malformed params column as no params', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: BROADCAST,
        channel: CHANNEL,
        metaChannel: META_CHANNEL,
        recipients: [
          // Rows created before migration 038 carry NULL.
          recipient('r1', '+15551234567', null),
          recipient('r2', '+15559876543', 'not-an-array'),
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned.map((p) => p.params)).toEqual([[], []]);
  });

  it('fails unsendable rows up front so they stop blocking the status', async () => {
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          channel: CHANNEL,
          metaChannel: META_CHANNEL,
          recipients: [
            recipient('r1', '+15551234567'),
            recipient('r2', null),
            recipient('r3', 'nonsense'),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    // Left 'pending', these would keep the broadcast in 'sending'
    // forever — the exact symptom being fixed.
    expect(unsendable).toBe(2);
    expect(writes.failedIds).toEqual(['r2', 'r3']);
    expect(writes.failedUpdate?.status).toBe('failed');
    expect(plan.planned).toHaveLength(1);
  });

  it('caps one pass and reports the leftover', async () => {
    const many = Array.from({ length: RESUME_MAX_PER_REQUEST + 25 }, (_, i) =>
      recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0')),
    );
    const { plan, remaining } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, channel: CHANNEL, metaChannel: META_CHANNEL, recipients: many }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST);
    // Surfaced to the caller rather than silently dropped.
    expect(remaining).toBe(25);
  });

  it('404s a broadcast that is not on this account', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: null }),
        'acct-1',
        'bc-1',
        'pending',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses when there is nothing outstanding', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: BROADCAST, channel: CHANNEL, metaChannel: META_CHANNEL, recipients: [] }),
        'acct-1',
        'bc-1',
        'failed',
      ),
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('resolves the template row for header + button components', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, template_language: 'en_US' },
        channel: CHANNEL,
        metaChannel: META_CHANNEL,
        recipients: [recipient('r1', '+15551234567')],
        templates: [
          {
            id: 'tpl-1',
            user_id: 'u-1',
            name: 'order_update',
            // Synced from Meta as bare 'en' — the resolver bridges it.
            language: 'en',
            body_text: 'Your order {{1}} ships on {{2}}',
          },
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.templateRow?.language).toBe('en');
  });

  it('resolves the channel the original broadcast used, not the current account default', async () => {
    const writes: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          // The account's CURRENT default channel would resolve to
          // whatever `channel` here returns, but the original
          // broadcast's own channel_id must be what's queried for.
          broadcast: { ...BROADCAST, channel_id: 'ch-original', send_delay_ms: null },
          channel: CHANNEL,
          metaChannel: META_CHANNEL,
          recipients: [recipient('r1', '+15551234567')],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(writes.channelIdQueried).toBe('ch-original');
  });

  it('carries send_delay_ms from the broadcast row onto the returned plan', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, channel_id: 'ch-1', send_delay_ms: 750 },
        channel: CHANNEL,
        metaChannel: META_CHANNEL,
        recipients: [recipient('r1', '+15551234567')],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(plan.delayMs).toBe(750);
  });

  it('clamps an out-of-range send_delay_ms before using it, same ceiling as the create endpoint', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, channel_id: 'ch-1', send_delay_ms: 999_999 },
        channel: CHANNEL,
        metaChannel: META_CHANNEL,
        recipients: [recipient('r1', '+15551234567')],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(plan.delayMs).toBe(MAX_RESUME_DELAY_MS);
  });

  it('shrinks the planned slice below RESUME_MAX_PER_REQUEST when a large send_delay_ms would blow the time budget', async () => {
    const many = Array.from({ length: RESUME_MAX_PER_REQUEST + 25 }, (_, i) =>
      recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0')),
    );
    // Clamped delay ends up at MAX_RESUME_DELAY_MS (10s); the budget
    // divided by that gives the expected slice size.
    const { plan, remaining } = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, channel_id: 'ch-1', send_delay_ms: 999_999 },
        channel: CHANNEL,
        metaChannel: META_CHANNEL,
        recipients: many,
      }),
      'acct-1',
      'bc-1',
      'pending',
    );

    const expectedSlice = Math.floor(RESUME_TIME_BUDGET_MS / MAX_RESUME_DELAY_MS);
    expect(expectedSlice).toBeLessThan(RESUME_MAX_PER_REQUEST);
    expect(plan.planned).toHaveLength(expectedSlice);
    expect(remaining).toBe(many.length - expectedSlice);
  });

  it('still resolves the account default when the original broadcast has no channel_id (pre-Plan-5 rows)', async () => {
    const writes: PlanWrites = {};
    const { plan } = await planBroadcastResume(
      planDb(
        {
          broadcast: { ...BROADCAST, channel_id: null, send_delay_ms: null },
          channel: CHANNEL,
          metaChannel: META_CHANNEL,
          recipients: [recipient('r1', '+15551234567')],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    // No `id`-filtered channels lookup happened — resolveChannelForSend
    // fell straight through to the is_default branch, unchanged from
    // pre-Plan-5 behavior.
    expect(writes.channelIdQueried).toBeUndefined();
    expect(plan.delayMs).toBeUndefined();
  });
});
