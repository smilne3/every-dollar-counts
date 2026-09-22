import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same module-scope hazard as tests/unit/ingest-env-guard.test.ts: lib/ingest.ts pulls in
// supabaseAdmin at import time. Here the stub is a recording `from()` rather than a bare {},
// because these tests need syncAndStore to run all the way to the upsert to prove the filter
// is actually wired in -- a pure helper that nothing calls would pass a unit test and still
// let mortgage rows into the database.
const { supabaseAdmin } = vi.hoisted(() => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin }))

const { syncItem } = vi.hoisted(() => ({ syncItem: vi.fn() }))
vi.mock('@/lib/sync', () => ({ syncItem }))

const { assertEnvMatchesDatabase } = vi.hoisted(() => ({ assertEnvMatchesDatabase: vi.fn() }))
vi.mock('@/lib/app-env', () => ({ assertEnvMatchesDatabase }))

vi.mock('@/lib/plaid', () => ({ plaidEnv: 'sandbox', plaidClient: {} }))

import { isCashFlowAccount, syncAndStore } from '@/lib/ingest'

type AcctRow = { account_id: string; type: string | null }

type State = {
  accounts: AcctRow[]
  accountsError: { message: string } | null
  upserted: { plaid_transaction_id: string; account_id: string }[]
  cursorWrites: unknown[]
}

function installAdmin(state: State) {
  supabaseAdmin.from.mockImplementation((table: string) => {
    if (table === 'accounts') {
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: state.accounts, error: state.accountsError }),
        }),
      }
    }
    if (table === 'transactions') {
      return {
        select: () => ({ in: () => ({ not: () => Promise.resolve({ data: [], error: null }) }) }),
        upsert: (rows: State['upserted']) => {
          state.upserted.push(...rows)
          return Promise.resolve({ error: null })
        },
        update: () => ({ in: () => Promise.resolve({ error: null }) }),
      }
    }
    if (table === 'plaid_items') {
      return {
        update: (patch: unknown) => {
          state.cursorWrites.push(patch)
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    }
    throw new Error(`unexpected table: ${table}`)
  })
}

function freshState(accounts: AcctRow[], accountsError: State['accountsError'] = null): State {
  return { accounts, accountsError, upserted: [], cursorWrites: [] }
}

function plaidTxn(transaction_id: string, account_id: string) {
  return {
    account_id,
    transaction_id,
    amount: -3752.28,
    date: '2026-09-02',
    name: 'CITY TAX PMT',
    merchant_name: null,
    personal_finance_category: {
      primary: 'INCOME',
      detailed: 'INCOME_TAX_REFUND',
      confidence_level: 'LOW',
    },
  }
}

const ITEM = { id: 'item-1', household_id: 'hh-1', access_token: 'tok', cursor: 'c0' }

// A mortgage or brokerage account is balance-sheet, not cash flow: its balance feeds netWorth()
// but its transactions are either mirrors of money already counted on the funding account (the
// monthly PAYMENT) or the servicer moving escrow on your behalf (CITY TAX PMT, which Plaid tags
// INCOME_TAX_REFUND at LOW confidence and which then reads as household income).
describe('isCashFlowAccount', () => {
  it('excludes loan accounts', () => {
    expect(isCashFlowAccount('loan')).toBe(false)
  })

  it('excludes investment accounts', () => {
    expect(isCashFlowAccount('investment')).toBe(false)
  })

  it('includes depository accounts', () => {
    expect(isCashFlowAccount('depository')).toBe(true)
  })

  it('includes credit accounts', () => {
    expect(isCashFlowAccount('credit')).toBe(true)
  })

  // Deliberately a denylist. 017_app_env.sql states the principle this follows: filtering that
  // "fails toward real transactions vanishing from the dashboard" is the worse failure, because
  // silence is indistinguishable from having no transactions. An allowlist of depository+credit
  // would swallow any type Plaid adds later, and every account whose row has not been stored yet.
  it('includes an unrecognised type, so a new Plaid type is never silently dropped', () => {
    expect(isCashFlowAccount('crypto')).toBe(true)
  })

  it('includes an account whose type is unknown', () => {
    expect(isCashFlowAccount(null)).toBe(true)
  })
})

describe('syncAndStore drops non-cash-flow transactions', () => {
  beforeEach(() => {
    supabaseAdmin.from.mockReset()
    syncItem.mockReset()
    assertEnvMatchesDatabase.mockReset()
    assertEnvMatchesDatabase.mockResolvedValue(undefined)
  })

  it('never upserts a transaction from a loan account', async () => {
    const state = freshState([
      { account_id: 'mortgage-1', type: 'loan' },
      { account_id: 'checking-1', type: 'depository' },
    ])
    installAdmin(state)
    syncItem.mockResolvedValue({
      added: [plaidTxn('escrow-tax', 'mortgage-1'), plaidTxn('paycheck', 'checking-1')],
      modified: [],
      removed: [],
      next_cursor: 'c1',
    })

    await syncAndStore(ITEM)

    expect(state.upserted.map((r) => r.plaid_transaction_id)).toEqual(['paycheck'])
  })

  it('never upserts a MODIFIED transaction from a loan account either', async () => {
    const state = freshState([{ account_id: 'mortgage-1', type: 'loan' }])
    installAdmin(state)
    syncItem.mockResolvedValue({
      added: [],
      modified: [plaidTxn('escrow-tax', 'mortgage-1')],
      removed: [],
      next_cursor: 'c1',
    })

    await syncAndStore(ITEM)

    expect(state.upserted).toEqual([])
  })

  it('keeps a transaction whose account row has not been stored yet', async () => {
    const state = freshState([])
    installAdmin(state)
    syncItem.mockResolvedValue({
      added: [plaidTxn('unknown-acct-txn', 'brand-new-acct')],
      modified: [],
      removed: [],
      next_cursor: 'c1',
    })

    await syncAndStore(ITEM)

    expect(state.upserted.map((r) => r.plaid_transaction_id)).toEqual(['unknown-acct-txn'])
  })

  it('still advances the cursor when every transaction was dropped', async () => {
    const state = freshState([{ account_id: 'mortgage-1', type: 'loan' }])
    installAdmin(state)
    syncItem.mockResolvedValue({
      added: [plaidTxn('escrow-tax', 'mortgage-1')],
      modified: [],
      removed: [],
      next_cursor: 'c1',
    })

    await syncAndStore(ITEM)

    expect(state.cursorWrites).toEqual([{ cursor: 'c1' }])
  })

  // The account-type lookup is the one thing standing between a mortgage row and the income
  // total, so an unreadable answer must not be treated as "no exclusions". Throwing leaves the
  // cursor untouched, which is the same recovery every other write error in this function uses:
  // Plaid re-sends the batch on the next sync.
  it('throws and leaves the cursor alone when account types cannot be read', async () => {
    const state = freshState([], { message: 'connection reset' })
    installAdmin(state)
    syncItem.mockResolvedValue({
      added: [plaidTxn('escrow-tax', 'mortgage-1')],
      modified: [],
      removed: [],
      next_cursor: 'c1',
    })

    await expect(syncAndStore(ITEM)).rejects.toThrow('connection reset')
    expect(state.upserted).toEqual([])
    expect(state.cursorWrites).toEqual([])
  })
})
