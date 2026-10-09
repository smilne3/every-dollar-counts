import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TransactionRow } from '@/components/TransactionRow'
import type { ResolvedCategory } from '@/lib/category-rules'

afterEach(cleanup)

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const txn = {
  id: 't1',
  date: '2026-08-29',
  name: 'JOE S DEN',
  merchant_name: 'Joe S Den' as string | null,
  amount: 100,
  user_category: null as string | null,
  pfc_primary: null as string | null,
  pfc_detailed: null as string | null,
  reimbursable_amount: null as number | null,
  reimbursable_note: null as string | null,
}

const FOOD: ResolvedCategory = { name: 'Food', source: 'bank', ruleId: null, bankName: 'Food' }
const LEARNED: ResolvedCategory = { name: 'Grocery', source: 'rule', ruleId: 'r1', bankName: 'Food' }

// TransactionRow renders a <tr>, which is only valid inside a table.
function renderRow(overrides: Partial<typeof txn> = {}, category: ResolvedCategory = FOOD) {
  return render(
    <table>
      <tbody>
        <TransactionRow t={{ ...txn, ...overrides }} category={category} categoryOptions={['Food', 'Grocery']} />
      </tbody>
    </table>
  )
}

// The "your share" line used to be mounted only when a transaction was marked. Ticking the box
// therefore added a second line to the amount cell, growing that row and pushing every row below it
// down the page — so after each tick the reader's place had moved (#50). The line is now always in
// the DOM and merely hidden, which keeps the row's height identical in both states.
describe('TransactionRow amount cell', () => {
  it('reserves the share line even when nothing is marked', () => {
    const { container } = renderRow()
    const reserved = container.querySelector('td .invisible')
    expect(reserved).not.toBeNull()
    expect(screen.queryByText(/your share/)).toBeNull()
  })

  it('shows the share once the transaction is marked', () => {
    renderRow({ reimbursable_amount: 40 })
    expect(screen.getByText(/your share -\$60\.00/)).toBeTruthy()
  })

  // Ticking the box marks the WHOLE amount, so this is the state most marked rows are in. The
  // remainder is zero, and negating a zero gave -0, which Intl renders as "-$0.00". This test
  // used to pass the fully-marked amount and assert only /your share/, so it exercised the bug
  // without ever seeing it.
  it('renders a fully-marked share as zero, not as minus zero', () => {
    renderRow({ reimbursable_amount: 100 })
    expect(screen.getByText('your share $0.00')).toBeTruthy()
  })

  // jsdom computes no layout, so this asserts the mechanism rather than the pixels: only
  // visibility:hidden (`invisible`) keeps the line's space. display:none (`hidden`) would leave the
  // element in the DOM — passing any "is it rendered?" check — while collapsing the row exactly as
  // before. The distinction IS the fix.
  it('hides the placeholder with visibility, not display', () => {
    const { container } = renderRow()
    const line = container.querySelector('td span.block') as HTMLElement
    expect(line).not.toBeNull()
    expect(line.className).toContain('invisible')
    expect(line.className.split(/\s+/)).not.toContain('hidden')
  })

  // A lone ASCII space collapses under white-space: normal, so the reserved line would have no
  // line box and the row would grow on every tick — #50 again. The non-breaking space is what
  // makes `invisible` actually reserve height. Nothing else in the suite distinguishes them.
  it('reserves the line with a non-breaking space, which does not collapse', () => {
    const { container } = renderRow()
    const line = container.querySelector('td span.block') as HTMLElement
    expect(line.textContent).toBe(' ')
  })

  // The route refuses credit-card payments (#31), so the editor must not be offered on one. The
  // guard moved out of RowMenu and into this cell, and nothing covered it.
  it('offers no editor on a credit-card payment', () => {
    renderRow({ pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })
    expect(screen.queryByRole('button', { name: /partial reimbursable amount/ })).toBeNull()
  })

  it('offers the editor on an ordinary charge', () => {
    renderRow()
    expect(screen.getByRole('button', { name: /partial reimbursable amount/ })).toBeTruthy()
  })


  // A card payment is real on the statement but is your own money moving between your own accounts.
  // Both legs are already kept out of every total (#31); the leg that credits the card was still
  // painted emerald — this table's colour for money arriving — so $7,866.69 read as income.
  it('reads a credit-card payment as a transfer, not as income', () => {
    const { container } = renderRow({
      amount: -7866.69, // negative: money INTO the card, the leg that looked like income
      pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
      name: 'CAPITAL ONE AUTOPAY PYMT',
      merchant_name: null,
    })
    const amountCell = container.querySelectorAll('td')[3]
    expect(amountCell.className).not.toContain('text-emerald')
    expect(amountCell.className).toContain('text-muted')
    const note = 'between accounts'
    expect(screen.getByText(note)).toBeTruthy()
    // The Amount column gives ~128px of content and this line is nowrap, which at text-xs is about
    // 19 characters. Two longer versions shipped and truncated to a useless ellipsis before this
    // one fit, so the budget is asserted rather than remembered.
    expect(note.length).toBeLessThanOrEqual(19)
  })

  it('still paints ordinary income emerald', () => {
    const { container } = renderRow({ amount: -2772.63, pfc_detailed: 'INCOME_WAGES' })
    expect(container.querySelectorAll('td')[3].className).toContain('text-emerald')
  })


  // Setting user_category flips isCreditCardPayment to false and re-enters BOTH legs into the
  // totals. On a real $7,866.69 payment that is the difference between September spending of
  // $3,949.16 and MINUS $3,917.53. The control does not belong here.
  it('offers no category picker on a credit-card payment', () => {
    renderRow({ pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText('Card payment')).toBeTruthy()
  })

  it('still offers the picker on an ordinary charge', () => {
    renderRow()
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

})

// Spec §8.1. The route now refuses every card payment (spec §6.1 step 4), including one someone
// filed by hand before #28, or picked before Plaid re-tagged the row as a card payment, so the row
// must not offer a picker that always fails. It shows the pick as plain text.
describe('TransactionRow card payment with a pick', () => {
  it('shows the pick as text, with no picker', () => {
    renderRow({ pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', user_category: 'Shopping' })
    expect(screen.getByText('Shopping')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('still says Card payment when there is no pick', () => {
    renderRow({ pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })
    expect(screen.getByText('Card payment')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})

describe('TransactionRow learned marker (#28)', () => {
  const marker = () => screen.queryByRole('link', { name: /learned from/ })

  it('appears only when a rule changed the name', () => {
    renderRow({}, LEARNED)
    const link = marker()!
    expect(link.getAttribute('href')).toBe('/settings#category-rules')
    expect(link.getAttribute('aria-label')).toBe('Grocery, learned from Joe S Den. Manage in Settings → Category rules.')
    expect(link.getAttribute('title')).toBe(link.getAttribute('aria-label'))
    cleanup()
    renderRow({}, { name: 'Food', source: 'rule', ruleId: 'r1', bankName: 'Food' })
    expect(marker()).toBeNull()
    cleanup()
    renderRow({}, FOOD)
    expect(marker()).toBeNull()
  })

  // The marker means "a rule filed this"; a pick the person made is not a rule's doing.
  it('a hand pick shows no marker', () => {
    renderRow({ user_category: 'Grocery' }, { name: 'Grocery', source: 'pick', ruleId: null, bankName: 'Food' })
    expect(marker()).toBeNull()
  })

  // The card-payment cell is text and never takes a rule; a marker there would point at nothing.
  it('never marks a card payment', () => {
    renderRow({ pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }, LEARNED)
    expect(marker()).toBeNull()
  })

  // The marker stays on the picker's line (#28 spec §8.1): only the picker container and the marker
  // sit in it.
  it('keeps the cell to one no-wrap line: the picker container, then the marker', () => {
    const { container } = renderRow({}, LEARNED)
    const cell = container.querySelectorAll('td')[2]
    const line = cell.firstElementChild as HTMLElement
    expect(line.className).toContain('flex-nowrap')
    expect(line.className).toContain('items-start')
    expect(line.children).toHaveLength(2)
    expect((line.children[0] as HTMLElement).className).toMatch(/\bmin-w-0\b.*\bflex-1\b|\bflex-1\b.*\bmin-w-0\b/)
    expect(line.children[0].querySelector('select')).not.toBeNull()
    expect(line.children[1]).toBe(marker())
    expect((line.children[1] as HTMLElement).className).toContain('shrink-0')
  })

  // A save error renders inside the picker container, so it cannot push the marker off the line.
  it('keeps the marker beside the select while an error shows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, redirected: false, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ error: 'This transaction just changed. Refresh and try again.' }) }))
    const { container } = renderRow({}, LEARNED)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Food' } })
    const alert = await screen.findByRole('alert')
    const line = container.querySelectorAll('td')[2].firstElementChild as HTMLElement
    expect(line.children[0].contains(alert)).toBe(true)
    expect(line.children[1]).toBe(marker())
    vi.unstubAllGlobals()
  })
})

// CategoryPicker keys its stale-alert reset on source as well as name, so the row must hand it the
// source: a rule equal to the bank's category being removed changes the reason, not the name.
describe('TransactionRow category source', () => {
  it("passes the category's source to the picker, so a change of reason clears its alert", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      redirected: false,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: 'This transaction just changed. Refresh and try again.' }),
    }))
    const agreeing: ResolvedCategory = { name: 'Food', source: 'rule', ruleId: 'r1', bankName: 'Food' }
    const row = (category: ResolvedCategory) => (
      <table>
        <tbody>
          <TransactionRow t={txn} category={category} categoryOptions={['Food', 'Grocery']} />
        </tbody>
      </table>
    )
    const { rerender } = render(row(agreeing))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Grocery' } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    rerender(row(FOOD))
    expect(screen.queryByRole('alert')).toBeNull()
    vi.unstubAllGlobals()
  })
})
