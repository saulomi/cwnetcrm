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

-- ---- meta_channels (renamed from whatsapp_config) ------------
-- Renaming preserves the existing primary key, UNIQUE(account_id),
-- indexes, RLS policies, and the set_updated_at trigger — none of
-- those reference the table by name inside their definitions, so
-- they keep working under the new name with no redefinition needed.
--
-- Guarded by relkind (not just IF EXISTS): once this section has
-- run once, `whatsapp_config` is the compatibility VIEW created
-- below, not a table — `ALTER TABLE ... RENAME` on a re-run must
-- skip rather than error against the view.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'whatsapp_config' AND relkind = 'r'
  ) THEN
    ALTER TABLE whatsapp_config RENAME TO meta_channels;
  END IF;
END $$;

ALTER TABLE meta_channels ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id) ON DELETE CASCADE;

-- Backfill: every pre-existing row gets a matching `channels` row
-- (provider='meta', is_default=true — this is the account's only
-- WhatsApp connection today, by definition, since whatsapp_config
-- had UNIQUE(account_id)).
WITH inserted AS (
  INSERT INTO channels (account_id, provider, label, status, is_default, created_by, created_at, updated_at)
  SELECT
    mc.account_id,
    'meta',
    'WhatsApp',
    CASE WHEN mc.status = 'connected' THEN 'connected' ELSE 'disconnected' END,
    true,
    mc.user_id,
    mc.created_at,
    mc.updated_at
  FROM meta_channels mc
  WHERE mc.channel_id IS NULL
  RETURNING id, account_id
)
UPDATE meta_channels mc
SET channel_id = inserted.id
FROM inserted
WHERE mc.account_id = inserted.account_id
  AND mc.channel_id IS NULL;

ALTER TABLE meta_channels ALTER COLUMN channel_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'meta_channels_channel_id_key'
  ) THEN
    ALTER TABLE meta_channels ADD CONSTRAINT meta_channels_channel_id_key UNIQUE (channel_id);
  END IF;
END $$;

-- Auto-provision a `channels` row on INSERT if the caller didn't
-- set channel_id — keeps `POST /api/whatsapp/config`'s existing
-- insert path (which knows nothing about `channels`) working
-- unchanged. meta_channels keeps UNIQUE(account_id), so this only
-- ever runs once per account.
CREATE OR REPLACE FUNCTION meta_channels_auto_provision_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.channel_id IS NULL THEN
    INSERT INTO channels (account_id, provider, label, status, is_default, created_by)
    VALUES (
      NEW.account_id,
      'meta',
      'WhatsApp',
      CASE WHEN NEW.status = 'connected' THEN 'connected' ELSE 'disconnected' END,
      true,
      NEW.user_id
    )
    RETURNING id INTO NEW.channel_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_provision_channel ON meta_channels;
CREATE TRIGGER auto_provision_channel
  BEFORE INSERT ON meta_channels
  FOR EACH ROW EXECUTE FUNCTION meta_channels_auto_provision_channel();

-- Clean up the matching `channels` row when a meta_channels row is
-- deleted directly (e.g. today's DELETE /api/whatsapp/config, which
-- deletes through the compatibility view below).
CREATE OR REPLACE FUNCTION meta_channels_cleanup_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM channels WHERE id = OLD.channel_id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS cleanup_channel ON meta_channels;
CREATE TRIGGER cleanup_channel
  AFTER DELETE ON meta_channels
  FOR EACH ROW EXECUTE FUNCTION meta_channels_cleanup_channel();

-- Compatibility view: exact original whatsapp_config column set.
-- A single-table, no-join, no-aggregate view like this is
-- automatically updatable in Postgres, so the existing
-- select/insert/update/delete calls in
-- src/app/api/whatsapp/config/route.ts and
-- src/app/api/whatsapp/webhook/route.ts keep working with zero
-- code changes. channel_id is deliberately NOT exposed here —
-- code written before this plan has no reason to see it.
CREATE OR REPLACE VIEW whatsapp_config AS
SELECT
  id, user_id, phone_number_id, waba_id, access_token, verify_token,
  status, connected_at, created_at, updated_at, account_id,
  registered_at, subscribed_apps_at, last_registration_error
FROM meta_channels;
