import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AccountList } from '@/components/AccountList'

afterEach(cleanup)

// `subtype` is required by AccountCard's Account type — null so the card falls back to `type`,
// which fixes what each card's name line reads and therefore what the matcher below looks for.
const accounts = Array.from({ length: 12 }, (_, i) => ({
  id: `a${i}`,
  name: `Account ${i}`,
  type: 'depository',
  subtype: null,
  current_balance: 100 + i,
  iso_currency_code: 'USD',
}))

// AccountCard's name line reads "Account 4 · depository". Matching on the bare name finds nothing,
// and a loose /Account 1/ would match Account 1, 10 and 11 at once.
//
// It has to be matched on `textContent`, not with a plain string: the card puts the subtype in its
// own <span> (`{name} · <span>{subtype ?? type}</span>`), and getByText's default matcher reads
// only an element's OWN text nodes, so it sees "Account 4 · " and never the whole line. textContent
// puts the line back together, and exactly one element carries it — the card itself also holds the
// balance, and every wrapper above it holds more than one card.
const nameLine = (i: number) =>
  screen.getByText((_content, el) => el?.textContent === `Account ${i} · depository`)

describe('AccountList', () => {
  // Accounts are reference material, not the reason the page was opened (§4). Twelve cards is a
  // lot of thumb between the reader and the end of the page.
  //
  // Asserted on the wrapper's class, not on absence: every card stays in the document at every
  // width, and `md:contents` takes the wrapper out of the box tree from `md` up, so the desktop
  // grid renders exactly as it did (a Global Constraint) even though the markup around each extra
  // is new. `hidden` below `md` keeps the extras out of the phone list and out of the
  // accessibility tree. Same shape as StatCard's dual strings in Task 2.
  const wrapperOf = (i: number) => nameLine(i).closest('[data-account-extra]')

  it('shows the first four outright', () => {
    render(<AccountList accounts={accounts} />)
    expect(nameLine(0)).toBeTruthy()
    expect(nameLine(3)).toBeTruthy()
    expect(wrapperOf(3)).toBeNull() // not an "extra" — always visible
  })

  it('keeps the rest out of the phone list until asked', () => {
    render(<AccountList accounts={accounts} />)
    expect(wrapperOf(4)!.className).toContain('hidden')
    expect(wrapperOf(4)!.className).toContain('md:contents')
  })

  // N is whatever the household actually has, not a hardcoded twelve.
  it('counts the accounts it is hiding in the control', () => {
    render(<AccountList accounts={accounts} />)
    expect(screen.getByRole('button', { name: 'Show all 12' })).toBeTruthy()
  })

  // `toBe('contents')`, not `not.toContain('hidden')`: an empty className also contains no
  // `hidden`, and would drop the eight extras into one block-level wrapper. Nothing is visibly
  // wrong until a reader who expanded on a phone crosses `md` — rotation, a tablet, a resized
  // window — and the grid collapses to a single column. The mirror of the collapsed-state string.
  it('reveals the rest when the control is used', () => {
    render(<AccountList accounts={accounts} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 12' }))
    expect(wrapperOf(11)!.className).toBe('contents')
  })

  // A disclosure control states its own state. The label changing from "Show all 12" to
  // "Show fewer" conveys it on activation, but nothing exposes it to a reader landing on the
  // collapsed control cold.
  it('tells assistive tech whether it is expanded', () => {
    render(<AccountList accounts={accounts} />)
    const control = screen.getByRole('button', { name: 'Show all 12' })
    expect(control.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(control)
    expect(screen.getByRole('button', { name: 'Show fewer' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('offers a way back once expanded', () => {
    render(<AccountList accounts={accounts} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 12' }))
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeTruthy()
  })

  // Four or fewer is already the whole list, so a control that reveals nothing must not appear.
  it('offers no control when everything is already shown', () => {
    render(<AccountList accounts={accounts.slice(0, 4)} />)
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
  })

  // The three below pin class strings rather than behaviour, because jsdom computes no layout and
  // the strings are therefore the only evidence a layout constraint holds. Each one was written
  // after a mutation proved the tests above passed against markup that was broken: dropping
  // `md:hidden` from the control, and cutting the grid's track counts, both went unnoticed.

  // `hidden md:contents` exactly: `md:contents` alone shows all twelve on a phone, `hidden` alone
  // takes the extras out of the desktop grid, and a typo in either does the same silently.
  it('wraps each extra in exactly the two classes the layout depends on', () => {
    render(<AccountList accounts={accounts} />)
    expect(wrapperOf(4)!.className).toBe('hidden md:contents')
  })

  // From `md` up every account is already on screen, so a control offering to reveal them is both
  // useless and a change to desktop, which this stage must not make.
  it('keeps the control off the desktop layout', () => {
    render(<AccountList accounts={accounts} />)
    expect(screen.getByRole('button', { name: 'Show all 12' }).className).toContain('md:hidden')
  })

  // This string used to live in app/(app)/dashboard/page.tsx and came across untouched. Moving a
  // class string is exactly when it can drift without anything noticing.
  it('keeps the grid it was lifted out of the page with', () => {
    const { container } = render(<AccountList accounts={accounts} />)
    const grid = container.firstElementChild!.firstElementChild!
    expect(grid.className).toBe('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3')
  })

  it('renders nothing rather than an empty shell when there are no accounts', () => {
    const { container } = render(<AccountList accounts={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
