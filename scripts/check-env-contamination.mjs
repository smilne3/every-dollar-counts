// Reports household financial rows whose environment does not match the environment that owns
// their bank. READ-ONLY: this script issues no writes and no deletes.
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

const { data: items, error: itemErr } = await admin
  .from('plaid_items')
  .select('id, plaid_env, institution_name')
if (itemErr) die('plaid_items', itemErr)

const envByItem = new Map(items.map((i) => [i.id, i.plaid_env]))
const envCounts = items.reduce((acc, i) => {
  acc[i.plaid_env] = (acc[i.plaid_env] ?? 0) + 1
  return acc
}, {})

console.log('Linked banks by environment:', envCounts)

// Exact count first, so truncation below is detectable. PostgREST caps an unbounded select
// (1000 rows by default) and reports no error at all -- a truncated read would classify only the
// rows it happened to receive and then print "Clean", a false all-clear on a check that gates a
// production decision. Compare against the count and refuse rather than guess.
const { count: accountCount, error: accCountErr } = await admin
  .from('accounts')
  .select('*', { count: 'exact', head: true })
if (accCountErr) die('accounts', accCountErr)

const { data: accounts, error: accErr } = await admin
  .from('accounts')
  .select('id, account_id, name, plaid_item_id')
if (accErr) die('accounts', accErr)
if (accounts.length !== accountCount) {
  console.error(
    `Read ${accounts.length} of ${accountCount} accounts — the result was truncated, so this ` +
      'check cannot honestly report "Clean". Re-run it with pagination before deciding anything.'
  )
  process.exit(1)
}

// An account whose owning bank row is gone cannot be attributed to any environment at all.
const orphanAccounts = accounts.filter((a) => !envByItem.has(a.plaid_item_id))
const sandboxAccounts = accounts.filter((a) => envByItem.get(a.plaid_item_id) === 'sandbox')

const { count: sandboxTxnCount, error: txnErr } = await admin
  .from('transactions')
  .select('*', { count: 'exact', head: true })
  .in(
    'account_id',
    sandboxAccounts.length ? sandboxAccounts.map((a) => a.account_id) : ['__none__']
  )
if (txnErr) die('transactions', txnErr)

const { data: assets, error: assetErr } = await admin
  .from('manual_assets')
  .select('id, name, plaid_env')
if (assetErr) die('manual_assets', assetErr)

console.log('')
console.log(`Sandbox-owned accounts:     ${sandboxAccounts.length}`)
console.log(`Sandbox-owned transactions: ${sandboxTxnCount ?? 0}`)
console.log(`Accounts with no owning bank row: ${orphanAccounts.length}`)
console.log('Manual assets by environment:', assets.reduce((acc, a) => {
  acc[a.plaid_env] = (acc[a.plaid_env] ?? 0) + 1
  return acc
}, {}))

// manual_assets is reported above but deliberately NOT part of `dirty`. Migration 011's
// unique (household_id, name) means there is structurally one 'Home' row per household, and the
// number in it is the real home value whichever environment typed it -- a 'sandbox' stamp there
// records the last writer, not contamination. Excluding it is the intent, not an oversight.
const dirty =
  sandboxAccounts.length > 0 || (sandboxTxnCount ?? 0) > 0 || orphanAccounts.length > 0
console.log('')
if (dirty) {
  console.log('CONTAMINATION FOUND. scripts/reset-plaid-data.mjs --confirm removes sandbox rows.')
  process.exit(2)
}
console.log('Clean: every account and transaction belongs to a bank in a single environment.')
