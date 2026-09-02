import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TransactionRow } from '@/components/TransactionRow'

afterEach(cleanup)

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const txn = {
  id: 't1',
  date: '2026-08-29',
  name: 'JOE S DEN',
  merchant_name: 'Joe S Den',
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

})
