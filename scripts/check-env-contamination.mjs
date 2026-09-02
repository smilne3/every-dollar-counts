// Reports household financial rows whose environment does not match the environment that OWNS
// this database. READ-ONLY: this script issues no writes and no deletes.
//
// The owner is app_env (db/migrations/017_app_env.sql), not a hardcoded guess. An earlier version
// looked for 'sandbox' rows specifically, which meant it could only ever see contamination in one
// direction -- a sandbox database polluted with production rows printed "Clean" -- and it never
// checked the app_env row itself, which is the single value every guarded write now depends on.
//
// accounts and transactions have no plaid_env column of their own (#23) and do not need one --
// their environment is derivable through the existing foreign keys:
//   accounts.plaid_item_id -> plaid_items.plaid_env
//   transactions.account_id -> accounts.account_id -> accounts.plaid_item_id -> plaid_items
//
// Usage: node --env-file=.env.local scripts/check-env-contamination.mjs
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !svc) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}
const admin = createClient(url, svc, { auth: { persistSession: false } })

function die(what, error) {
  console.error(`Could not read ${what}: ${error.message}`)
  process.exit(1)
}

// Exact count first, so truncation is detectable. PostgREST caps an unbounded select (1000 rows by
// default) and reports no error at all -- a truncated read would classify only the rows it happened
// to receive and then print "Clean", a false all-clear on a check that gates a production decision.
// Compare against the count and refuse rather than guess. Every table read here goes through this,
// because guarding one of them and not the others just moves the false all-clear somewhere else.
async function readAll(table, columns) {
  const { count, error: countErr } = await admin
    .from(table)
    .select('*', { count: 'exact', head: true })
  if (countErr) die(table, countErr)

  const { data, error } = await admin.from(table).select(columns)
  if (error) die(table, error)
  // Two different failures, so two different messages. PostgREST returns count as null when the
  // Content-Range header is missing or unparseable, and `0 !== null` is true -- so an EMPTY table
  // with no count header used to abort claiming truncation, which is both alarming and wrong.
  // Both still refuse, because a read we cannot verify cannot honestly report "Clean" either way.
  if (count == null) {
    console.error(
      `No exact row count came back for ${table}, so truncation would be undetectable. This ` +
        'check cannot honestly report "Clean" without one — even if the table is simply empty.'
    )
    process.exit(1)
  }
  if (data.length !== count) {
    console.error(
      `Read ${data.length} of ${count} ${table} rows — the result was truncated, so this check ` +
        'cannot honestly report "Clean". Re-run it with pagination before deciding anything.'
    )
    process.exit(1)
  }
  return data
}

// The database's own claim about which environment owns it. Everything below is measured against
// this, so an unreadable or missing row is fatal rather than a warning -- exactly like lib/app-env.ts.
const { data: appEnv, error: appEnvErr } = await admin
  .from('app_env')
  .select('plaid_env')
  .maybeSingle()
if (appEnvErr) die('app_env', appEnvErr)
if (!appEnv) {
  console.error('app_env has no row: run db/migrations/017_app_env.sql. Nothing to check against.')
  process.exit(1)
}
const owner = appEnv.plaid_env
console.log(`This database says it belongs to: ${owner}`)

const items = await readAll('plaid_items', 'id, plaid_env, institution_name')

const envByItem = new Map(items.map((i) => [i.id, i.plaid_env]))
const envCounts = items.reduce((acc, i) => {
  acc[i.plaid_env] = (acc[i.plaid_env] ?? 0) + 1
  return acc
}, {})

console.log('Linked banks by environment:', envCounts)

// A bank from any environment other than the owning one. This is also the check that would catch a
// mis-seeded app_env row: if every bank here is production and app_env says sandbox, every bank is
// reported foreign, which is the visible symptom of the row being wrong rather than the banks.
const foreignItems = items.filter((i) => i.plaid_env !== owner)

const accounts = await readAll('accounts', 'id, account_id, name, plaid_item_id')

// accounts.plaid_item_id is NOT NULL with ON DELETE CASCADE (002), so this should be structurally
// impossible. It is checked anyway: if it is ever non-empty, something is wrong with this script's
// own reads rather than with the data, and it must not print "Clean".
const orphanAccounts = accounts.filter((a) => !envByItem.has(a.plaid_item_id))
const foreignAccounts = accounts.filter(
  (a) => envByItem.has(a.plaid_item_id) && envByItem.get(a.plaid_item_id) !== owner
)

const { count: foreignTxnCount, error: txnErr } = await admin
  .from('transactions')
  .select('*', { count: 'exact', head: true })
  .in(
    'account_id',
    foreignAccounts.length ? foreignAccounts.map((a) => a.account_id) : ['__none__']
  )
if (txnErr) die('transactions', txnErr)

const assets = await readAll('manual_assets', 'id, name, plaid_env')

console.log('')
console.log(`Banks from another environment:      ${foreignItems.length}`)
console.log(`Accounts from another environment:   ${foreignAccounts.length}`)
console.log(`Transactions from another environment: ${foreignTxnCount ?? 0}`)
console.log(`Accounts with no owning bank row:    ${orphanAccounts.length}`)
console.log('Manual assets by environment:', assets.reduce((acc, a) => {
  acc[a.plaid_env] = (acc[a.plaid_env] ?? 0) + 1
  return acc
}, {}))

// manual_assets is reported above but deliberately NOT part of `dirty`. Migration 011's
// unique (household_id, name) means there is structurally one 'Home' row per household, and the
// number in it is the real home value whichever environment typed it -- a foreign stamp there
// records the last writer, not contamination. Excluding it is the intent, not an oversight.
const dirty =
  foreignItems.length > 0 ||
  foreignAccounts.length > 0 ||
  (foreignTxnCount ?? 0) > 0 ||
  orphanAccounts.length > 0
console.log('')
if (dirty) {
  console.log(
    `CONTAMINATION FOUND. Confirm app_env is right (it says "${owner}") BEFORE deleting anything — ` +
      'a mis-seeded row makes every real bank look foreign. If the row is right, ' +
      'scripts/reset-plaid-data.mjs --confirm removes sandbox rows.'
  )
  process.exit(2)
}
console.log(`Clean: every bank, account and transaction belongs to "${owner}".`)
