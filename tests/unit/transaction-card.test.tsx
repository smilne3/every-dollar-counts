import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TransactionCard } from '@/components/TransactionCard'
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

function renderCard(overrides: Partial<typeof txn> = {}) {
  return render(
    <TransactionCard t={{ ...txn, ...overrides }} categoryName="Food" categoryOptions={['Food', 'Grocery']} />
  )
}

describe('TransactionCard', () => {
  it('shows the merchant and the display amount', () => {
    renderCard()
    expect(screen.getByText('Joe S Den')).toBeTruthy()
    expect(screen.getByText('-$100.00')).toBeTruthy()
  })

  it('puts date and category on one muted meta line', () => {
    renderCard()
    expect(screen.getByText(/2026-08-29 · Food/)).toBeTruthy()
  })

  // Without this the mark is invisible until the row is opened, which makes "what have I already
  // marked?" answerable only by tapping every row in turn (spec §3.1).
  it('shows the share on the meta line once marked', () => {
    renderCard({ reimbursable_amount: 40 })
    expect(screen.getByText(/your share -\$60\.00/)).toBeTruthy()
  })

  it('omits the share line when nothing is marked', () => {
    renderCard()
    expect(screen.queryByText(/your share/)).toBeNull()
  })

  it('opens a sheet when tapped', () => {
    renderCard()
    expect(screen.getByRole('button', { name: /Joe S Den/ })).toBeTruthy()
  })
})

// The containment promised by spec §9: two presentations, one meaning.
describe('phone card and desktop row agree', () => {
  const cases = [
    { name: 'ordinary outflow', o: {} },
    { name: 'income inflow', o: { amount: -2772.63, pfc_detailed: 'INCOME_WAGES' } },
    { name: 'credit-card payment', o: { amount: -7866.69, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } },
  ]
  for (const c of cases) {
    it(`render the same amount text for a ${c.name}`, () => {
      const { container: cardEl } = render(
        <TransactionCard t={{ ...txn, ...c.o }} categoryName="Food" categoryOptions={['Food']} />
      )
      const cardText = cardEl.textContent ?? ''
      cleanup()
      const { container: rowEl } = render(
        <table><tbody>
          <TransactionRow t={{ ...txn, ...c.o }} categoryName="Food" categoryOptions={['Food']} />
        </tbody></table>
      )
      const rowText = rowEl.textContent ?? ''
      const amount = rowText.match(/-?\$[\d,]+\.\d{2}/)?.[0]
      expect(amount).toBeDefined()
      expect(cardText).toContain(amount as string)
    })
  }
})
