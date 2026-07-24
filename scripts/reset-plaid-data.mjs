// Deletes SANDBOX linked banks and their data, so the app can be re-linked against real banks.
// Deleting plaid_items cascades to accounts (002) and, via the 010 FK, to transactions.
// KEEPS households, memberships, categories, budgets, and goals — and every production item.
//
// Usage: node --env-file=.env.local scripts/reset-plaid-data.mjs --confirm
//
// WHY THIS IS SCOPED TO plaid_env='sandbox' RATHER THAN "delete everything":
// there is exactly ONE Supabase project behind local dev, preview, and production. A --confirm flag
// is no protection when the same command, run a day later out of shell history, would wipe real
// bank data. The environment filter is the actual guard; --confirm is a speed bump.
//
// Delete this script once the cutover is done. It has one job and one day to do it, and it lives in
// a repo whose only database is the real one.
import { createClient } from '@supabase/supabase-js'

if (!process.argv.includes('--confirm')) {
  console.error(
    'Refusing to run without --confirm. This deletes sandbox-linked banks and their transactions.'
  )
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !svc) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const admin = createClient(url, svc, { auth: { persistSession: false } })

// Count production rows so we can say plainly what is being kept.
const { count: prodCount, error: prodErr } = await admin
  .from('plaid_items')
  .select('*', { count: 'exact', head: true })
  .eq('plaid_env', 'production')
if (prodErr) {
  console.error('Could not read plaid_items:', prodErr.message)
  process.exit(1)
}

const { data: sandbox, error: readErr } = await admin
  .from('plaid_items')
  .select('id')
  .eq('plaid_env', 'sandbox')
if (readErr) {
  console.error('Could not read plaid_items:', readErr.message)
  process.exit(1)
}

const { error } = await admin.from('plaid_items').delete().eq('plaid_env', 'sandbox')
if (error) {
  console.error('Delete failed:', error.message)
  process.exit(1)
}

console.log(
  `✓ Removed ${sandbox?.length ?? 0} sandbox bank(s); their accounts and transactions cascaded away.`
)
console.log(
  `✓ Left ${prodCount ?? 0} production bank(s) untouched. Households, categories, budgets, and goals kept.`
)
