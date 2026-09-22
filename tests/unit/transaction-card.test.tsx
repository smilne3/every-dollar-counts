import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { TransactionCard } from '@/components/TransactionCard'
import { TransactionRow } from '@/components/TransactionRow'

afterEach(cleanup)
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

// jsdom does not implement showModal()/close() on <dialog>, so Dialog's open effect cannot run
// without these. Copied verbatim from tests/unit/confirm-dialog.test.tsx:11-18, which needs them
// for the same reason. Real modal behaviour — focus trap, Escape, backdrop — is the platform's
// job and is verified in the browser (Task 4, Step 5), not here.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

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
  // Scoped to the row itself: the sheet (Task 3) mounts a dialog with the same merchant name in
  // its title, present in the DOM even while closed (native <dialog> hides it with `display:
  // none`, which `getByRole` respects but a plain `getByText` does not). Unscoped, this test would
  // fail on "Found multiple elements" rather than on anything meaningful.
  it('shows the merchant and the display amount', () => {
    renderCard()
    const row = screen.getByRole('button', { name: /Joe S Den/ })
    expect(within(row).getByText('Joe S Den')).toBeTruthy()
    expect(within(row).getByText('-$100.00')).toBeTruthy()
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

  it('renders the whole row as a button, named for the merchant', () => {
    renderCard()
    expect(screen.getByRole('button', { name: /Joe S Den/ })).toBeTruthy()
  })

  // A card payment moves money between your own accounts — see lib/transaction-presentation.ts.
  // Painting it emerald (the colour this app uses for money arriving) made a real $7,866.69
  // payment read as income (#31). TONE_CLASS is exercised directly elsewhere; this asserts the
  // same guarantee at this component's own boundary.
  it('never paints a card payment amount as income', () => {
    renderCard({ amount: -7866.69, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })
    const amountEl = screen.getByText('$7,866.69')
    expect(amountEl.className).not.toContain('text-emerald')
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

describe('TransactionCard sheet', () => {
  function openSheet(overrides: Partial<typeof txn> = {}) {
    render(
      <TransactionCard t={{ ...txn, ...overrides }} categoryName="Food" categoryOptions={['Food', 'Grocery']} />
    )
    fireEvent.click(screen.getByRole('button', { name: /edit/ }))
  }

  it('offers the category picker on an ordinary charge', () => {
    openSheet()
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  // The constraint this whole plan is most at risk of breaking. Setting user_category on a card
  // payment re-enters both legs into the totals: on a real $7,866.69 payment that is September
  // spending of $3,949.16 versus MINUS $3,917.53.
  it('offers no picker, checkbox or editor on a credit-card payment', () => {
    openSheet({ pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', amount: -7866.69 })
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /partial reimbursable amount/ })).toBeNull()
  })

  it('explains what a card payment is instead of offering controls', () => {
    openSheet({ pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', amount: -7866.69 })
    expect(screen.getByText(/moves between your accounts/)).toBeTruthy()
  })
})
