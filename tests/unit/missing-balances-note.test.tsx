import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// RefreshButton reloads through the app router, which nothing mounts here.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

import { MissingBalancesNote } from '@/components/MissingBalancesNote'

afterEach(cleanup)

const bank = (id: string, institution_name: string | null, status = 'ok') => ({ id, institution_name, status })
const accountAt = (plaid_item_id: string) => ({ plaid_item_id })

// What the note says, or '' when it renders nothing.
const said = (container: HTMLElement) => container.querySelector('p')?.textContent ?? ''

// #170: a bank whose first balance pull failed has no accounts, and so no transactions, so every
// figure leaves it out while every other bank's are in. The page tests check where each page puts
// the note; this checks what it says, and what it offers.
describe('MissingBalancesNote', () => {
  it('shows nothing while every bank has an account', () => {
    const { container } = render(
      <MissingBalancesNote items={[bank('capone', 'Capital One'), bank('amex', 'Amex')]} accounts={[accountAt('capone'), accountAt('amex')]} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('shows nothing for a household with no banks', () => {
    const { container } = render(<MissingBalancesNote items={[]} accounts={[]} />)
    expect(container.innerHTML).toBe('')
  })

  // Only the bank that has no accounts: the others' balances are in.
  it('names the bank whose balances have not arrived, and offers Refresh, not Connect', () => {
    const { container } = render(
      <MissingBalancesNote items={[bank('capone', 'Capital One'), bank('amex', 'Amex')]} accounts={[accountAt('capone')]} />
    )
    expect(said(container)).toBe("Amex is connected, but its balances and transactions haven't arrived yet. Press Refresh to fetch them.")
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Refresh'])
  })

  // A page with a Refresh button of its own (the dashboard's header) keeps the words and drops the
  // note's button, so there aren't two.
  it('leaves its button out when told to, and still says to press Refresh', () => {
    const { container } = render(
      <MissingBalancesNote items={[bank('capone', 'Capital One'), bank('amex', 'Amex')]} accounts={[accountAt('capone')]} refreshButton={false} />
    )
    expect(said(container)).toBe("Amex is connected, but its balances and transactions haven't arrived yet. Press Refresh to fetch them.")
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('counts several banks whose balances have not arrived', () => {
    const { container } = render(
      <MissingBalancesNote items={[bank('capone', 'Capital One'), bank('amex', 'Amex'), bank('chase', 'Chase')]} accounts={[accountAt('capone')]} />
    )
    expect(said(container)).toBe("2 banks are connected, but their balances and transactions haven't arrived yet. Press Refresh to fetch them.")
  })

  it('says "Your bank" when the bank has no name', () => {
    const { container } = render(<MissingBalancesNote items={[bank('capone', 'Capital One'), bank('amex', null)]} accounts={[accountAt('capone')]} />)
    expect(said(container)).toBe("Your bank is connected, but its balances and transactions haven't arrived yet. Press Refresh to fetch them.")
  })

  // Refresh skips a broken login and retries the rest without fixing what stopped them, so a bank
  // that isn't syncing gets no promise and no Refresh. The banner above it links to Settings.
  it.each(['needs_reconnect', 'action_at_bank', 'temporarily_unavailable', 'config_error'])(
    'promises nothing for a bank that is %s, and offers no Refresh',
    (status) => {
      const { container } = render(
        <MissingBalancesNote items={[bank('capone', 'Capital One'), bank('amex', 'Amex', status)]} accounts={[accountAt('capone')]} />
      )
      expect(said(container)).toBe("Amex is connected, but its balances and transactions can't arrive until it's sorted out in Settings.")
      expect(screen.queryAllByRole('button')).toEqual([])
    }
  )

  it("counts several banks that aren't syncing", () => {
    const { container } = render(
      <MissingBalancesNote
        items={[bank('capone', 'Capital One'), bank('amex', 'Amex', 'needs_reconnect'), bank('chase', 'Chase', 'config_error')]}
        accounts={[accountAt('capone')]}
      />
    )
    expect(said(container)).toBe("2 banks are connected, but their balances and transactions can't arrive until they're sorted out in Settings.")
  })

  it('with one of each, says both, and offers Refresh for the one syncing', () => {
    const { container } = render(
      <MissingBalancesNote
        items={[bank('capone', 'Capital One'), bank('amex', 'Amex'), bank('chase', 'Chase', 'needs_reconnect')]}
        accounts={[accountAt('capone')]}
      />
    )
    expect(said(container)).toBe(
      "Amex is connected, but its balances and transactions haven't arrived yet. Press Refresh to fetch them. " +
        "Chase is connected, but its balances and transactions can't arrive until it's sorted out in Settings."
    )
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Refresh'])
  })

  // A bank broken with its accounts in is the banner's alone: its balances are in, if stale.
  it("says nothing of a bank that isn't syncing but has its accounts", () => {
    const { container } = render(
      <MissingBalancesNote items={[bank('capone', 'Capital One', 'needs_reconnect')]} accounts={[accountAt('capone')]} />
    )
    expect(container.innerHTML).toBe('')
  })

  // Nothing is broken, so it is quieter than the coral "isn't syncing" banner: a plain bordered
  // note in muted text, the same on every page.
  it('keeps a quieter look than the banner', () => {
    const { container } = render(<MissingBalancesNote items={[bank('amex', 'Amex')]} accounts={[]} />)
    const note = container.firstElementChild!
    expect(note.className).toBe(
      'flex flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between'
    )
    expect(container.querySelector('p')!.className).toBe('text-sm text-muted')
  })
})
