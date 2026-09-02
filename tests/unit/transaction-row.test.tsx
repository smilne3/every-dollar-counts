import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TransactionRow } from '@/components/TransactionRow'

afterEach(cleanup)

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const txn = {
  id: 't1',
  date: '2026-08-29',
  name: 'JOE S DEN',
  merchant_name: 'Joe S Den' as string | null,
  amount: 100,
  user_category: null as string | null,
  pfc_detailed: null as string | null,
  reimbursable_amount: null as number | null,
  reimbursable_note: null as string | null,
}

// TransactionRow renders a <tr>, which is only valid inside a table.
function renderRow(overrides: Partial<typeof txn> = {}) {
  return render(
    <table>
      <tbody>
        <TransactionRow t={{ ...txn, ...overrides }} categoryName="Food" categoryOptions={['Food']} />
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
    renderRow({ reimbursable_amount: 100 })
    expect(screen.getByText(/your share/)).toBeTruthy()
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
    expect(screen.getByText('between your accounts')).toBeTruthy()
    // The Amount column is 160px and this line is nowrap: anything longer truncates to an ellipsis
    // that explains nothing. This is the budget.
    expect('between your accounts'.length).toBeLessThanOrEqual(22)
  })

  it('still paints ordinary income emerald', () => {
    const { container } = renderRow({ amount: -2772.63, pfc_detailed: 'INCOME_WAGES' })
    expect(container.querySelectorAll('td')[3].className).toContain('text-emerald')
  })

})
