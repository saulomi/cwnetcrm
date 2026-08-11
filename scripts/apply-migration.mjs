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
//   node scripts/apply-migration.mjs supabase/migrations/039_whatsapp_channels.sql
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
