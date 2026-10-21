import { describe, it, expect } from 'vitest'
import { balancesPending, bySync, notSyncing } from '@/lib/bank-state'

const bank = (institution_name: string | null, status: string, status_detail: string | null = null) => ({
  institution_name,
  status,
  status_detail,
})

// What the pages say about a bank with no accounts yet is split by what Refresh can do for it
// (#186). The sync route retries a bank that only didn't respond last time (lib/sync-policy.ts),
// skips one whose login broke, and fails again for one that needs something done at the bank or to
// its setup.
describe('bySync', () => {
  it.each(['ok', 'temporarily_unavailable'])('counts a bank that is %s as one Refresh can fetch from', (status) => {
    expect(bySync([bank('Amex', status)])).toEqual({ syncing: [bank('Amex', status)], behind: [] })
  })

  // A status this code has never seen is promised nothing.
  it.each(['needs_reconnect', 'action_at_bank', 'config_error', 'something_new'])(
    'counts a bank that is %s as one it cannot',
    (status) => {
      expect(bySync([bank('Amex', status)])).toEqual({ syncing: [], behind: [bank('Amex', status)] })
    }
  )

  // The banner and the average ask whether a bank's figures are current, and they aren't.
  it("leaves notSyncing() counting a bank that didn't respond last time as behind", () => {
    expect(notSyncing([bank('Amex', 'temporarily_unavailable')])).toEqual([bank('Amex', 'temporarily_unavailable')])
  })
})

describe('balancesPending', () => {
  it("says the balances and transactions haven't arrived", () => {
    expect(balancesPending([bank('Amex', 'ok')])).toBe("Amex is connected, but its balances and transactions haven't arrived yet.")
  })

  // Briefly, so the wait has a reason (#186).
  it("says when the bank didn't respond last time", () => {
    expect(balancesPending([bank('Amex', 'temporarily_unavailable')])).toBe(
      "Amex is connected, but its balances and transactions haven't arrived yet. It didn't respond last time."
    )
  })

  it.each([
    ['none of them', [bank('Amex', 'ok'), bank('Chase', 'ok')], ''],
    ['all of them', [bank('Amex', 'temporarily_unavailable'), bank('Chase', 'temporarily_unavailable')], " They didn't respond last time."],
    ['one of them', [bank('Amex', 'ok'), bank('Chase', 'temporarily_unavailable')], " Chase didn't respond last time."],
    ['one of them, with no name', [bank('Amex', 'ok'), bank(null, 'temporarily_unavailable')], " One of them didn't respond last time."],
    [
      'some of them',
      [bank('Amex', 'ok'), bank('Chase', 'temporarily_unavailable'), bank('Citi', 'temporarily_unavailable')],
      " 2 of them didn't respond last time.",
    ],
  ])('counts several banks, when %s didn\'t respond last time', (_, banks, why) => {
    expect(balancesPending(banks)).toBe(
      `${banks.length} banks are connected, but their balances and transactions haven't arrived yet.${why}`
    )
  })

  // #189: the sync route records a failure of this app's own as APP_ERROR, with the same status.
  // The bank may well have answered, so it isn't said not to have.
  it("doesn't say a bank whose sync failed on this app's side didn't respond", () => {
    expect(balancesPending([bank('Amex', 'temporarily_unavailable', 'APP_ERROR')])).toBe(
      "Amex is connected, but its balances and transactions haven't arrived yet."
    )
    expect(
      balancesPending([bank('Amex', 'temporarily_unavailable', 'APP_ERROR'), bank('Chase', 'temporarily_unavailable', 'INSTITUTION_DOWN')])
    ).toBe("2 banks are connected, but their balances and transactions haven't arrived yet. Chase didn't respond last time.")
  })
})
