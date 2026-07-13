// Links a Plaid SANDBOX bank to the household and pulls accounts + transactions.
// Mirrors the app's exchange/ingest pipeline (server-side), for verification/demo.
// Usage: node --env-file=.env.local scripts/seed-sandbox-bank.mjs
import { createClient } from '@supabase/supabase-js'
import { Configuration, PlaidApi, PlaidEnvironments, Products } from 'plaid'
import crypto from 'node:crypto'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
const encKey = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex')

function encrypt(plain) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const admin = createClient(url, svc, { auth: { persistSession: false } })
const plaid = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
        'Plaid-Version': '2020-09-14',
      },
    },
  })
)

const { data: households } = await admin.from('households').select('id, name').limit(1)
const household = households?.[0]
if (!household) { console.error('No household found.'); process.exit(1) }

const pt = await plaid.sandboxPublicTokenCreate({
  institution_id: 'ins_109508', // First Platypus Bank (sandbox)
  initial_products: [Products.Transactions],
})
const ex = await plaid.itemPublicTokenExchange({ public_token: pt.data.public_token })
const accessToken = ex.data.access_token

const { data: item } = await admin
  .from('plaid_items')
  .insert({
    household_id: household.id,
    item_id: ex.data.item_id,
    access_token_encrypted: encrypt(accessToken),
    institution_name: 'First Platypus Bank (Sandbox)',
  })
  .select('id')
  .single()

const acc = await plaid.accountsGet({ access_token: accessToken })
await admin.from('accounts').upsert(
  acc.data.accounts.map((a) => ({
    household_id: household.id,
    plaid_item_id: item.id,
    account_id: a.account_id,
    name: a.name,
    type: String(a.type),
    subtype: a.subtype ? String(a.subtype) : null,
    current_balance: a.balances.current,
    available_balance: a.balances.available,
    iso_currency_code: a.balances.iso_currency_code,
  })),
  { onConflict: 'account_id' }
)

// transactions/sync — retry a few times since sandbox data can lag a couple seconds.
let cursor, added = [], modified = []
for (let attempt = 0; attempt < 6; attempt++) {
  added = []; modified = []; cursor = undefined
  let hasMore = true
  while (hasMore) {
    const s = await plaid.transactionsSync({ access_token: accessToken, cursor })
    added = added.concat(s.data.added)
    modified = modified.concat(s.data.modified)
    hasMore = s.data.has_more
    cursor = s.data.next_cursor
  }
  if (added.length) break
  await sleep(2000)
}

const rows = [...added, ...modified].map((t) => ({
  household_id: household.id,
  account_id: t.account_id,
  plaid_transaction_id: t.transaction_id,
  amount: t.amount,
  date: t.date,
  name: t.name,
  merchant_name: t.merchant_name ?? null,
  pfc_primary: t.personal_finance_category?.primary ?? null,
  pfc_detailed: t.personal_finance_category?.detailed ?? null,
  pfc_confidence: t.personal_finance_category?.confidence_level ?? null,
  removed: false,
}))
if (rows.length) await admin.from('transactions').upsert(rows, { onConflict: 'plaid_transaction_id' })
await admin.from('plaid_items').update({ cursor }).eq('id', item.id)

console.log(`✓ Linked sandbox bank to "${household.name}": ${acc.data.accounts.length} accounts, ${rows.length} transactions.`)
