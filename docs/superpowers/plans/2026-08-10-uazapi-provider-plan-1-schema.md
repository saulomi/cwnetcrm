# Multi-Provider WhatsApp — Plano 1: Schema (channels) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `channels` / `meta_channels` / `uazapi_channels` schema (per the design spec) so an account can hold multiple simultaneous WhatsApp connections, while every existing query against `whatsapp_config` keeps working unchanged via a compatibility view.

**Architecture:** `whatsapp_config` is renamed to `meta_channels` and gains a `channel_id` FK into a new `channels` table (the cross-provider registry). A compatibility VIEW named `whatsapp_config` is recreated with the exact original column set, backed by BEFORE INSERT / AFTER DELETE triggers on `meta_channels` so existing app code (which only knows `whatsapp_config`) never needs to change in this plan. A new `uazapi_channels` table holds UAZAPI-specific fields. `conversations` and `messages` gain a nullable `channel_id` for later plans to populate.

**Tech Stack:** PostgreSQL (Supabase), raw SQL migrations, Node.js `pg` client for applying migrations (no `psql` binary available in this environment).

## Global Constraints

- Migration files live in `supabase/migrations/`, numbered sequentially (next is `037`), and every statement must be idempotent (`IF NOT EXISTS` / guarded `DO $$` blocks) — this repo's migrations are re-run defensively (see `013_whatsapp_config_phone_number_id_unique.sql`, `015_whatsapp_config_registration.sql` for the established style).
- RLS on every new table follows the `is_account_member(target_account_id UUID, min_role account_role_enum DEFAULT 'viewer')` pattern from `017_account_sharing.sql` — settings-class tables (connection credentials) require `'admin'` for insert/update/delete, any member can `SELECT`.
- **No existing behavior may change.** Every current caller of `whatsapp_config` (`select`, `insert`, `update`, `delete` — see `src/app/api/whatsapp/config/route.ts`, `src/app/api/whatsapp/webhook/route.ts`, `src/lib/whatsapp/send-message.ts`) must keep working with zero code changes after this plan. This plan is schema-only.
- No `psql` CLI is installed in this environment; migrations are applied via a Node script using the `pg` package and the Supabase **Session Pooler** connection string (IPv4 — direct connection is IPv6-only on this network, established earlier this project).
- Never commit a database connection string or password to the repo. The apply script reads `DATABASE_URL` from the environment only.

---

## File Structure

- Create: `supabase/migrations/037_whatsapp_channels.sql` — the full migration (built incrementally across tasks below).
- Create: `scripts/apply-migration.mjs` — small reusable Node script to apply a `.sql` file against `DATABASE_URL`. Not wired into any app code path; a dev-ops utility only.
- Modify: `package.json` — add `pg` as a devDependency (used only by `scripts/apply-migration.mjs`).

## Interfaces

- Produces: tables `channels`, `meta_channels` (renamed from `whatsapp_config`), `uazapi_channels`; columns `conversations.channel_id`, `messages.channel_id`; view `whatsapp_config` (compatibility, exact same columns as before this plan: `id, user_id, phone_number_id, waba_id, access_token, verify_token, status, connected_at, created_at, updated_at, account_id, registered_at, subscribed_apps_at, last_registration_error`).
- Consumes: existing `accounts`, `auth.users`, `is_account_member(UUID, account_role_enum)`, `update_updated_at_column()` (all defined in earlier migrations, unchanged).
- Later plans (2–5) will consume: `channels.id`, `channels.provider`, `channels.is_default`, `meta_channels.channel_id`, `uazapi_channels.channel_id`, `conversations.channel_id`, `messages.channel_id`. Exact column names above are load-bearing for those plans — do not rename without updating this document.

---

### Task 1: Migration-apply tooling

**Files:**
- Create: `scripts/apply-migration.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `node scripts/apply-migration.mjs <path-to-sql-file>` — reads `DATABASE_URL` from env, runs the file's full text as one query, exits 0 on success / 1 with the Postgres error on failure.

- [ ] **Step 1: Install `pg`**

```bash
cd "C:/Users/Saulo/orca/projects/wacrm"
npm install --save-dev pg
```

Expected: `package.json` gains `"pg"` under `devDependencies`; `package-lock.json` updates.

- [ ] **Step 2: Write the apply script**

Create `scripts/apply-migration.mjs`:

```javascript
// Applies a single .sql file to the database at $DATABASE_URL.
//
// Used for supabase/migrations/*.sql in this project — there is no
// Supabase CLI / psql binary wired into this environment, so
// migrations are applied by hand via the Session Pooler (IPv4)
// connection string from the Supabase dashboard
// (Project Settings → Database → Connection string → Session pooler).
//
// Usage:
//   $env:DATABASE_URL = "postgresql://...pooler.supabase.com:5432/postgres"
//   node scripts/apply-migration.mjs supabase/migrations/037_whatsapp_channels.sql
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const file = process.argv[2]
if (!file) {
  console.error('Usage: node scripts/apply-migration.mjs <path-to-sql-file>')
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}

const sql = readFileSync(file, 'utf8')
const client = new Client({ connectionString: process.env.DATABASE_URL })

try {
  await client.connect()
  await client.query(sql)
  console.log(`Applied ${file} successfully.`)
} catch (err) {
  console.error(`Failed to apply ${file}:`)
  console.error(err.message)
  process.exitCode = 1
} finally {
  await client.end()
}
```

- [ ] **Step 3: Verify the script runs (against an empty/no-op statement)**

Set `DATABASE_URL` to the real Session Pooler connection string from the Supabase dashboard (Project Settings → Database → Connection string → Session pooler) first, then:

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Set-Location "C:\Users\Saulo\orca\projects\wacrm"
"SELECT 1;" | Out-File -FilePath noop.sql -Encoding utf8
node scripts/apply-migration.mjs noop.sql
Remove-Item noop.sql
```

Expected: `Applied noop.sql successfully.`

- [ ] **Step 4: Commit**

```bash
git add scripts/apply-migration.mjs package.json package-lock.json
git commit -m "chore: add migration-apply script (pg + DATABASE_URL)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `channels` table

**Files:**
- Create: `supabase/migrations/037_whatsapp_channels.sql`

**Interfaces:**
- Produces: table `channels(id, account_id, provider, label, status, is_default, created_by, created_at, updated_at)`.

- [ ] **Step 1: Write the migration file header + `channels` table**

Create `supabase/migrations/037_whatsapp_channels.sql`:

```sql
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
```

- [ ] **Step 2: Apply to the dev DB**

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
node scripts/apply-migration.mjs supabase/migrations/037_whatsapp_channels.sql
```

Expected: `Applied ...037_whatsapp_channels.sql successfully.`

- [ ] **Step 3: Verify the table + RLS exist**

`apply-migration.mjs` only reports success/failure, not row data — run this inline check instead (same `DATABASE_URL` from Task 1):

```powershell
node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r1 = await c.query(\"SELECT table_name FROM information_schema.tables WHERE table_name = 'channels'\");
  const r2 = await c.query(\"SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'channels'\");
  console.log('table exists:', r1.rowCount === 1);
  console.log('policy count:', r2.rows[0].n);
  await c.end();
})();
"
```

Expected: `table exists: true`, `policy count: 4`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/037_whatsapp_channels.sql
git commit -m "feat(db): add channels table (multi-provider WhatsApp registry)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `meta_channels` (rename `whatsapp_config`, backfill, compat view)

**Files:**
- Modify: `supabase/migrations/037_whatsapp_channels.sql` (append)

**Interfaces:**
- Produces: table `meta_channels` (all of `whatsapp_config`'s original columns + `channel_id UUID NOT NULL UNIQUE`), view `whatsapp_config` (original column set, insert/update/delete-through-view working via triggers), functions `meta_channels_auto_provision_channel()`, `meta_channels_cleanup_channel()`.
- Consumes: `channels` table from Task 2.

- [ ] **Step 1: Append the rename + backfill + view section**

Append to `supabase/migrations/037_whatsapp_channels.sql`:

```sql
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
```

- [ ] **Step 2: Apply to the dev DB**

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
node scripts/apply-migration.mjs supabase/migrations/037_whatsapp_channels.sql
```

Expected: `Applied ...037_whatsapp_channels.sql successfully.` (re-running Task 2's section is a harmless no-op — every statement is `IF NOT EXISTS`/`CREATE OR REPLACE`/guarded).

- [ ] **Step 3: Verify data integrity — every meta_channels row has a channel, no orphans**

```powershell
node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r1 = await c.query('SELECT count(*)::int AS n FROM meta_channels WHERE channel_id IS NULL');
  const r2 = await c.query(\"SELECT count(*)::int AS n FROM meta_channels mc JOIN channels c ON c.id = mc.channel_id WHERE c.provider <> 'meta' OR c.is_default <> true\");
  const r3 = await c.query('SELECT count(*)::int AS a, (SELECT count(*)::int FROM channels) AS b FROM meta_channels');
  console.log('meta_channels with no channel_id (expect 0):', r1.rows[0].n);
  console.log('mismatched provider/is_default (expect 0):', r2.rows[0].n);
  console.log('meta_channels count vs channels count:', r3.rows[0]);
  const r4 = await c.query('SELECT * FROM whatsapp_config LIMIT 1');
  console.log('whatsapp_config view columns:', r4.fields.map(f => f.name));
  await c.end();
})();
"
```

Expected: both counts `0`; `whatsapp_config view columns` lists exactly `id, user_id, phone_number_id, waba_id, access_token, verify_token, status, connected_at, created_at, updated_at, account_id, registered_at, subscribed_apps_at, last_registration_error` (no `channel_id`).

- [ ] **Step 4: Regression-test the existing app against the renamed table**

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Set-Location "C:\Users\Saulo\orca\projects\wacrm"
npm run typecheck
npx vitest run
```

Expected: both pass with the same results as before this task (no source file changed — this step exists to catch anything unexpectedly depending on `whatsapp_config` being a real table rather than a view, e.g. a `.rpc()` doing DDL introspection).

Then smoke-test manually: open Settings → WhatsApp in the running app, confirm the existing config still loads and "Testar conexão" still reports connected (proves SELECT-through-view + the API route's decrypt/verify path work unchanged).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/037_whatsapp_channels.sql
git commit -m "feat(db): rename whatsapp_config to meta_channels, add compat view

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `uazapi_channels` table

**Files:**
- Modify: `supabase/migrations/037_whatsapp_channels.sql` (append)

**Interfaces:**
- Produces: table `uazapi_channels(id, channel_id, instance_id, instance_token, base_url, connected_phone, profile_name, qr_code, webhook_secret, last_error, created_at, updated_at)`.
- Consumes: `channels` table from Task 2.

- [ ] **Step 1: Append the `uazapi_channels` section**

```sql
-- ---- uazapi_channels ------------------------------------------
CREATE TABLE IF NOT EXISTS uazapi_channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id UUID NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  -- Encrypted at rest with the same ENCRYPTION_KEY / encryption.ts
  -- used for meta_channels.access_token (wired up in Plan 4).
  instance_token TEXT NOT NULL,
  base_url TEXT NOT NULL,
  connected_phone TEXT,
  profile_name TEXT,
  qr_code TEXT,
  webhook_secret TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uazapi_channels_instance ON uazapi_channels(instance_id);

ALTER TABLE uazapi_channels ENABLE ROW LEVEL SECURITY;

-- uazapi_channels has no account_id of its own — join through
-- channels for tenancy, same pattern as any child-of-a-tenant-row
-- table elsewhere in this schema (e.g. broadcast_recipients).
DROP POLICY IF EXISTS uazapi_channels_select ON uazapi_channels;
DROP POLICY IF EXISTS uazapi_channels_insert ON uazapi_channels;
DROP POLICY IF EXISTS uazapi_channels_update ON uazapi_channels;
DROP POLICY IF EXISTS uazapi_channels_delete ON uazapi_channels;
CREATE POLICY uazapi_channels_select ON uazapi_channels FOR SELECT USING (
  EXISTS (SELECT 1 FROM channels c WHERE c.id = uazapi_channels.channel_id AND is_account_member(c.account_id))
);
CREATE POLICY uazapi_channels_insert ON uazapi_channels FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM channels c WHERE c.id = uazapi_channels.channel_id AND is_account_member(c.account_id, 'admin'))
);
CREATE POLICY uazapi_channels_update ON uazapi_channels FOR UPDATE USING (
  EXISTS (SELECT 1 FROM channels c WHERE c.id = uazapi_channels.channel_id AND is_account_member(c.account_id, 'admin'))
);
CREATE POLICY uazapi_channels_delete ON uazapi_channels FOR DELETE USING (
  EXISTS (SELECT 1 FROM channels c WHERE c.id = uazapi_channels.channel_id AND is_account_member(c.account_id, 'admin'))
);

DROP TRIGGER IF EXISTS set_updated_at ON uazapi_channels;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON uazapi_channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

- [ ] **Step 2: Apply to the dev DB**

```powershell
node scripts/apply-migration.mjs supabase/migrations/037_whatsapp_channels.sql
```

Expected: `Applied ...037_whatsapp_channels.sql successfully.`

- [ ] **Step 3: Verify**

```powershell
node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r1 = await c.query(\"SELECT table_name FROM information_schema.tables WHERE table_name = 'uazapi_channels'\");
  const r2 = await c.query(\"SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'uazapi_channels'\");
  console.log('table exists:', r1.rowCount === 1);
  console.log('policy count:', r2.rows[0].n);
  await c.end();
})();
"
```

Expected: `table exists: true`, `policy count: 4`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/037_whatsapp_channels.sql
git commit -m "feat(db): add uazapi_channels table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `channel_id` on `conversations` and `messages`

**Files:**
- Modify: `supabase/migrations/037_whatsapp_channels.sql` (append)

**Interfaces:**
- Produces: `conversations.channel_id`, `messages.channel_id` (both nullable `UUID REFERENCES channels(id) ON DELETE SET NULL`). `NULL` means "resolve via the account's default channel" — the exact resolution rule is implemented in Plan 2 (`send-message.ts`); this task only adds the column.

- [ ] **Step 1: Append the column additions**

```sql
-- ---- routing columns --------------------------------------------
-- NULL means "use the account's is_default channel" — resolved at
-- send/receive time (Plan 2/3), not backfilled here. ON DELETE SET
-- NULL (not CASCADE) so removing a channel never deletes
-- conversation/message history.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
```

- [ ] **Step 2: Apply to the dev DB**

```powershell
node scripts/apply-migration.mjs supabase/migrations/037_whatsapp_channels.sql
```

Expected: `Applied ...037_whatsapp_channels.sql successfully.`

- [ ] **Step 3: Verify**

```powershell
node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r1 = await c.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'conversations' AND column_name = 'channel_id'\");
  const r2 = await c.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'channel_id'\");
  console.log('conversations.channel_id exists:', r1.rowCount === 1);
  console.log('messages.channel_id exists:', r2.rowCount === 1);
  await c.end();
})();
"
```

Expected: both `true`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/037_whatsapp_channels.sql
git commit -m "feat(db): add channel_id routing column to conversations and messages

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Full idempotency + regression pass

**Files:** none (verification only)

- [ ] **Step 1: Re-apply the entire migration file from scratch to confirm idempotency**

```powershell
node scripts/apply-migration.mjs supabase/migrations/037_whatsapp_channels.sql
```

Expected: `Applied ...037_whatsapp_channels.sql successfully.` — running the whole file a second time in one shot must be a clean no-op (this is what protects a future fresh environment / CI database from failing when this migration runs once, top to bottom).

- [ ] **Step 2: Full regression suite**

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Set-Location "C:\Users\Saulo\orca\projects\wacrm"
npm run typecheck
npx vitest run
```

Expected: identical pass/fail counts to the baseline before this plan (`git stash` the migration/script and re-run once beforehand if you need a literal before/after diff — no `src/` file changed in this plan, so no test behavior should differ).

- [ ] **Step 3: Manual smoke test**

With the dev server running (`npm run dev`), sign in and open **Settings → WhatsApp**:
- Existing config still shows as loaded (phone number ID, WABA ID visible, token masked).
- "Testar conexão" still reports connected.
- Save (re-enter the access token) still succeeds and shows the same success toast as before.

- [ ] **Step 4: Update the design spec's status**

Edit `docs/superpowers/specs/2026-08-10-uazapi-provider-design.md`, changing:
```
Status: aprovado para planejamento
```
to:
```
Status: Plano 1 (schema) implementado
```

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Saulo/orca/projects/wacrm"
git add docs/superpowers/specs/2026-08-10-uazapi-provider-design.md
git commit -m "docs: mark uazapi-provider spec Plano 1 (schema) as implemented

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
