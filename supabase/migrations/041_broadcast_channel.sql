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
