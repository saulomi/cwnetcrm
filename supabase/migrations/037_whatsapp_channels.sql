-- ============================================================
-- Multi-provider WhatsApp channels
--
-- Introduces `channels` as the cross-provider registry an account's
-- WhatsApp connections are tracked through, so an account can run
-- more than one connection at once (e.g. one Meta number + one
-- UAZAPI number). `whatsapp_config` is renamed to `meta_channels`
-- and a compatibility VIEW named `whatsapp_config` is recreated
-- with its original column set, so every existing query keeps
-- working unchanged.
--
-- See docs/superpowers/specs/2026-08-10-uazapi-provider-design.md
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ---- channels -----------------------------------------------
CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta', 'uazapi')),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('connected', 'disconnected', 'connecting', 'error')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channels_account ON channels(account_id);

-- At most one default channel per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_account_default
  ON channels(account_id)
  WHERE is_default = true;

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channels_select ON channels;
DROP POLICY IF EXISTS channels_insert ON channels;
DROP POLICY IF EXISTS channels_update ON channels;
DROP POLICY IF EXISTS channels_delete ON channels;
CREATE POLICY channels_select ON channels FOR SELECT USING (is_account_member(account_id));
CREATE POLICY channels_insert ON channels FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY channels_update ON channels FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY channels_delete ON channels FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON channels;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
