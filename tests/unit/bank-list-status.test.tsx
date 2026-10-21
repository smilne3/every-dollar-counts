import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BankList } from '@/components/BankList'

// The line under each bank's name in Settings → Banks: what's wrong with it, and whose it is. A
// broken login's Reconnect button opens Plaid Link, which can't run here; tests/unit/
// bank-list-reconnect.test.tsx covers that.
vi.mock('react-plaid-link', () => ({ usePlaidLink: () => ({ open: () => {}, ready: false }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

afterEach(cleanup)

const bank = (status: string, status_detail: string | null = null) => ({
  id: 'item-1',
  institution_name: 'Amex',
  status,
  status_detail,
  products: ['transactions'],
  created_at: '2026-05-07',
})

// The line under the bank's name.
function lineFor(name: string): HTMLElement {
  return screen.getByText(name).nextElementSibling as HTMLElement
}

describe("BankList: each bank's line", () => {
  it.each([
    ['ok', null, 'Connected'],
    ['temporarily_unavailable', 'INSTITUTION_DOWN', 'This bank didn’t respond last time. Nothing to do — try Refresh later.'],
    // #189: a sync that failed on this app's own side. Settings has no Refresh button, so it says
    // what Refresh will do rather than to press it.
    ['temporarily_unavailable', 'APP_ERROR', 'This app couldn’t save this bank’s latest data. Refresh will try again.'],
    ['needs_reconnect', 'ITEM_LOGIN_REQUIRED', 'Connection lost — reconnect to resume syncing.'],
    ['action_at_bank', 'ITEM_LOCKED', 'Your account is locked. Unlock it on the bank’s website, then press Refresh.'],
    ['config_error', 'ENV_MISMATCH', "Something is wrong with this connection's setup (ENV_MISMATCH). Reconnecting won't fix it."],
  ])('for a bank that is %s (%s), says so', (status, detail, line) => {
    render(<BankList items={[bank(status, detail)]} slotsUsed={6} lifetimeSlots={10} />)
    expect(lineFor('Amex').textContent).toBe(line)
  })

  // Nothing the person can fix themselves, so quiet, like a bank that didn't respond.
  it("keeps a failure of this app's own as quiet as a bank that didn't respond", () => {
    render(<BankList items={[bank('temporarily_unavailable', 'APP_ERROR')]} slotsUsed={6} lifetimeSlots={10} />)
    expect(lineFor('Amex').className).toBe('text-xs text-muted')
  })
})
