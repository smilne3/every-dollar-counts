import { describe, it, expect, vi } from 'vitest'

// lib/ingest.ts imports supabaseAdmin at module scope (lib/supabase/admin.ts calls
// createClient(...) as a top-level side effect). Vitest does not load .env.local, so without
// this mock the import throws "supabaseUrl is required" before any test body runs — unrelated
// to what these tests are checking (transactionUpsertRow is a pure function that never touches
// supabaseAdmin). Mirrors how tests/unit/sync.test.ts mocks @/lib/plaid for the same reason.
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))

import { transactionUpsertRow } from '@/lib/ingest'
import { clampReimbursable } from '@/lib/reimbursements'

const plaidTxn = {
  account_id: 'acct-1',
  transaction_id: 'plaid-1',
  amount: 105,
  date: '2026-08-29',
  name: 'JOE S DEN',
  merchant_name: 'Joe S Den',
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT', confidence_level: 'HIGH' },
}

// The ONLY thing stopping a sync from wiping a user's marks is that these columns are absent from the
// upsert payload — PostgREST's ON CONFLICT DO UPDATE touches exactly the keys it is given. That is a
// property of this object's shape, not of anything the schema declares, so adding a column to it
// would silently start clobbering user data on every sync. This test is the tripwire.
describe('transactionUpsertRow', () => {
  it('never writes the user-owned columns', () => {
    const keys = Object.keys(transactionUpsertRow(plaidTxn, 'hh-1'))
    expect(keys).not.toContain('reimbursable_amount')
    expect(keys).not.toContain('reimbursable_note')
    expect(keys).not.toContain('user_category')
  })

  it('still writes every Plaid-owned column', () => {
    expect(transactionUpsertRow(plaidTxn, 'hh-1')).toEqual({
      household_id: 'hh-1',
      account_id: 'acct-1',
      plaid_transaction_id: 'plaid-1',
      amount: 105,
      date: '2026-08-29',
      name: 'JOE S DEN',
      merchant_name: 'Joe S Den',
      pfc_primary: 'FOOD_AND_DRINK',
      pfc_detailed: 'FOOD_AND_DRINK_RESTAURANT',
      pfc_confidence: 'HIGH',
      removed: false,
    })
  })
})

// The hazard the CHECK introduces. Plaid revises amounts on `modified` — a $105 authorisation
// settling at $95, say. If $105 was marked reimbursable, the revised row violates
// reimbursable_amount <= abs(amount) and the whole sync throws, wedging every later transaction
// behind it. Clamping first turns a broken sync into the obvious answer.
describe('clamping a mark to a revised amount', () => {
  it('lowers a mark that a revised amount would invalidate', () => {
    expect(clampReimbursable(105, 95)).toBe(95)
  })

  it('leaves a mark alone when it still fits', () => {
    expect(clampReimbursable(50, 95)).toBe(50)
  })
})
