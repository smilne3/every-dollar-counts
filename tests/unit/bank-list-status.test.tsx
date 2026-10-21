import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BankList } from '@/components/BankList'

// The line under each bank's name in Settings → Banks: what's wrong with it, and whose it is. A
// broken login's Reconnect button opens Plaid Link, which can't run here; tests/unit/
// bank-list-reconnect.test.tsx covers that.
vi.mock('react-plaid-link', () => ({ usePlaidLink: () => ({ open: () => {}, ready: false }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

afterEach(cleanup)

const bank = (status: string, status_detail: string | null = null, over: { id?: string; institution_name?: string } = {}) => ({
  id: 'item-1',
  institution_name: 'Amex',
  status,
  status_detail,
  products: ['transactions'],
  created_at: '2026-05-07',
  ...over,
})

// The line under the bank's name.
function lineFor(name: string): HTMLElement {
  return screen.getByText(name).nextElementSibling as HTMLElement
}

const NO_ACCOUNTS_YET = 'Connected, but its balances and transactions haven’t arrived yet. Refresh will fetch them.'

// Each status that isn't ok, and its line. Settings has no Refresh button (the dashboard has), so a
// line that needs Refresh says what Refresh will do rather than to press it (#189, #192).
const NOT_OK: [string, string, string][] = [
  ['temporarily_unavailable', 'INSTITUTION_DOWN', 'This bank didn’t respond last time. Nothing to do — the next Refresh will try again.'],
  // #189: a sync that failed on this app's own side.
  ['temporarily_unavailable', 'APP_ERROR', 'This app couldn’t save this bank’s latest data. Refresh will try again.'],
  ['needs_reconnect', 'ITEM_LOGIN_REQUIRED', 'Connection lost — reconnect to resume syncing.'],
  ['action_at_bank', 'ITEM_LOCKED', 'Your account is locked. Unlock it on the bank’s website, then Refresh will resume syncing.'],
  ['config_error', 'ENV_MISMATCH', "Something is wrong with this connection's setup (ENV_MISMATCH). Reconnecting won't fix it."],
]

// The rest of the codes that need something done at the bank, and one this code has never seen.
const AT_BANK: [string, string][] = [
  ['PASSWORD_RESET_REQUIRED', 'The bank wants a new password. Reset it on their website, then Refresh will resume syncing.'],
  ['USER_SETUP_REQUIRED', 'The bank needs you to finish something on their website, then Refresh will resume syncing.'],
  ['INSUFFICIENT_CREDENTIALS', 'The bank sign-in wasn’t completed. Try connecting again.'],
  ['ITEM_NOT_SUPPORTED', 'This bank can’t share this account with Plaid.'],
  ['NO_ACCOUNTS', 'No open accounts were found at this bank.'],
  ['A_CODE_FROM_LATER', 'This bank needs something from you on their website, then Refresh will resume syncing.'],
]

describe("BankList: each bank's line", () => {
  const all: [string, string | null, string][] = [['ok', null, 'Connected'], ...NOT_OK]
  it.each(all)('for a bank that is %s (%s), says so', (status, detail, line) => {
    render(<BankList items={[bank(status, detail)]} withoutAccounts={[]} slotsUsed={6} lifetimeSlots={10} />)
    expect(lineFor('Amex').textContent).toBe(line)
  })

  it.each(AT_BANK)('for a bank that needs something done at the bank (%s), says what', (detail, line) => {
    render(<BankList items={[bank('action_at_bank', detail)]} withoutAccounts={[]} slotsUsed={6} lifetimeSlots={10} />)
    expect(lineFor('Amex').textContent).toBe(line)
  })

  // Not "press Refresh", "try Refresh later" or "then Refresh.": in a line, Refresh is only ever what
  // will act. With no accounts yet, so an ok bank's line is the one that mentions Refresh.
  const everyLine: [string, string | null][] = [
    ['ok', null],
    ...NOT_OK.map(([status, detail]): [string, string] => [status, detail]),
    ...AT_BANK.map(([detail]): [string, string] => ['action_at_bank', detail]),
  ]
  it.each(everyLine)('never says to press a Refresh button, which Settings does not have (%s, %s)', (status, detail) => {
    render(<BankList items={[bank(status, detail)]} withoutAccounts={['item-1']} slotsUsed={6} lifetimeSlots={10} />)
    expect(lineFor('Amex').textContent).not.toMatch(/Refresh(?! will)/)
  })

  // Nothing the person can fix themselves, so quiet, like a bank that didn't respond.
  it("keeps a failure of this app's own as quiet as a bank that didn't respond", () => {
    render(<BankList items={[bank('temporarily_unavailable', 'APP_ERROR')]} withoutAccounts={[]} slotsUsed={6} lifetimeSlots={10} />)
    expect(lineFor('Amex').className).toBe('text-xs text-muted')
  })
})

// #186: a bank whose first balance pull failed is connected, with no accounts until Refresh brings
// them, and every figure leaves it out (#170). Its line said "Connected", and once other banks had
// accounts nothing else on Settings said otherwise.
describe('BankList: a bank with no accounts yet (#186)', () => {
  it("says a connected bank's balances and transactions haven't arrived, quietly", () => {
    render(<BankList items={[bank('ok')]} withoutAccounts={['item-1']} slotsUsed={6} lifetimeSlots={10} />)
    expect(lineFor('Amex').textContent).toBe(NO_ACCOUNTS_YET)
    // Nothing is broken, as on the dashboard's note.
    expect(lineFor('Amex').className).toBe('text-xs text-muted')
  })

  it('says it only of the bank with none', () => {
    const items = [bank('ok'), bank('ok', null, { id: 'item-2', institution_name: 'Chase' })]
    render(<BankList items={items} withoutAccounts={['item-2']} slotsUsed={6} lifetimeSlots={10} />)
    expect(lineFor('Amex').textContent).toBe('Connected')
    expect(lineFor('Chase').textContent).toBe(NO_ACCOUNTS_YET)
  })

  // What it needs is the thing to do, and its balances follow once it's done, so its line is the
  // same as with its accounts in.
  it.each(NOT_OK)('keeps the line of a bank that is %s (%s)', (status, detail, line) => {
    render(<BankList items={[bank(status, detail)]} withoutAccounts={['item-1']} slotsUsed={6} lifetimeSlots={10} />)
    expect(lineFor('Amex').textContent).toBe(line)
  })

  // Settings couldn't read the accounts, and says so above the list. No line guesses.
  it("says only Connected when it isn't known which banks have accounts", () => {
    render(<BankList items={[bank('ok')]} withoutAccounts={null} slotsUsed={6} lifetimeSlots={10} />)
    expect(lineFor('Amex').textContent).toBe('Connected')
  })
})
