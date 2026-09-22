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
  name: 'JOE S DEN' as string | null,
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

  // Ticking the checkbox marks the WHOLE amount, so the zero-remainder case is the commonest
  // marked state, not an edge one. Negating a zero remainder gave -0, which Intl renders as
  // "-$0.00" — on the meta line and in the accessible name both.
  it('renders a fully-marked share as zero, not as minus zero', () => {
    renderCard({ reimbursable_amount: 100 })
    const row = screen.getByRole('button', { name: /Joe S Den/ })
    expect(within(row).getByText(/your share \$0\.00/)).toBeTruthy()
    expect(row.getAttribute('aria-label')).toContain('your share $0.00')
  })

  it('omits the share line when nothing is marked', () => {
    renderCard()
    expect(screen.queryByText(/your share/)).toBeNull()
  })

  it('renders the whole row as a button, named for the merchant', () => {
    renderCard()
    expect(screen.getByRole('button', { name: /Joe S Den/ })).toBeTruthy()
  })

  // The aria-label REPLACES the button's accessible name rather than augmenting it, so anything
  // the meta line shows a sighted user has to be repeated into it or a screen-reader user hears
  // merchant + amount and nothing else. Cutting it back to exactly that left all 347 tests green,
  // which is why this now asserts the content rather than only that a name exists.
  it('carries the category and the share in its accessible name', () => {
    renderCard({ reimbursable_amount: 40 })
    const name = screen.getByRole('button', { name: /Joe S Den/ }).getAttribute('aria-label') ?? ''
    expect(name).toContain('Joe S Den')
    expect(name).toContain('Food')
    expect(name).toContain('-$100.00')
    expect(name).toContain('your share -$60.00')
  })

  // "Card payment" is the one piece of meaning a screen-reader user cannot recover from the
  // amount alone: the sheet will offer them no controls and they need to know why.
  it('names a card payment as one in its accessible name', () => {
    renderCard({ amount: -7866.69, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })
    expect(screen.getByRole('button', { name: /Card payment/ })).toBeTruthy()
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

// The containment promised by spec §9: "A test asserts the two render identical category, amount
// and card-payment state for the same transaction. This is how §2's accepted duplication cost is
// contained." §2 accepts that a row's presentation exists twice; this is the whole of what stops
// the two meaning different things.
//
// Each surface is read down to the four things that carry MEANING rather than markup — the label,
// the category, the amount text, and the tone class that says what KIND of money this is — and
// those are compared. The previous version compared the card's entire textContent against an
// amount scraped from the row, which the sheet's own `{date} · {money(display)}` line satisfied on
// its own: a wrong amount in the visible row still passed, on the sheet's copy.
describe('phone card and desktop row agree', () => {
  const TONES = ['text-emerald', 'text-muted', 'text-ink']

  // TONE_CLASS is the card-payment state made visible: neutral/text-muted for a card payment,
  // emerald for money in, ink for money out. Exactly one must be present, or comparing two `null`s
  // below would "agree" while proving nothing.
  function toneOf(el: Element): string {
    const classes = el.className.split(/\s+/)
    const found = TONES.filter((t) => classes.includes(t))
    expect(found).toHaveLength(1)
    return found[0]
  }

  type Surface = { label: string; category: string; amount: string; tone: string }

  // The visible row ONLY. The sheet mounts the same merchant name in its title and its own
  // `date · amount` line, so anything scoped to the whole card can be satisfied by the sheet.
  function phone(t: typeof txn): Surface {
    const { container } = render(
      <TransactionCard t={t} categoryName="Food" categoryOptions={['Food']} />
    )
    const row = container.querySelector('button') as HTMLElement
    const [main, amount] = Array.from(row.children)
    const [label, meta] = Array.from(main.children)
    return {
      label: label.textContent ?? '',
      // `date · category`, with ` · your share …` appended when the transaction is marked.
      category: (meta.textContent ?? '').split(' · ')[1] ?? '',
      amount: amount.textContent ?? '',
      tone: toneOf(amount),
    }
  }

  function desktop(t: typeof txn): Surface {
    const { container } = render(
      <table><tbody>
        <TransactionRow t={t} categoryName="Food" categoryOptions={['Food']} />
      </tbody></table>
    )
    const cells = container.querySelectorAll('td')
    const picker = cells[2].querySelector('select')
    return {
      label: cells[1].textContent ?? '',
      // A card payment gets prose where every other row gets the picker.
      category: picker ? picker.value : (cells[2].textContent ?? '').trim(),
      // The amount cell also holds the always-reserved share line beneath the figure.
      amount: (cells[3].textContent ?? '').match(/^-?\$[\d,]+\.\d{2}/)?.[0] ?? '',
      tone: toneOf(cells[3]),
    }
  }

  function bothWays(o: Partial<typeof txn>): [Surface, Surface] {
    const t = { ...txn, ...o }
    const card = phone(t)
    cleanup()
    return [card, desktop(t)]
  }

  const cases: { name: string; o: Partial<typeof txn> }[] = [
    { name: 'ordinary outflow', o: {} },
    { name: 'income inflow', o: { amount: -2772.63, pfc_detailed: 'INCOME_WAGES' } },
    { name: 'credit-card payment', o: { amount: -7866.69, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } },
    { name: 'partly-marked charge', o: { reimbursable_amount: 40 } },
    // M5: the two surfaces used to disagree here — the card said "Transaction", the row rendered
    // the empty label — because presentTransaction returned null and each decided for itself.
    { name: 'transaction with no merchant and no name', o: { merchant_name: null, name: null } },
  ]

  for (const c of cases) {
    it(`agree on label, category, amount and tone for a ${c.name}`, () => {
      const [card, row] = bothWays(c.o)
      expect(card.label).toBe(row.label)
      expect(card.category).toBe(row.category)
      expect(card.amount).toBe(row.amount)
      expect(card.tone).toBe(row.tone)
    })
  }

  // Spelled out rather than left to the loop's "they match each other": two surfaces could agree
  // on the wrong thing. This is the $7,866.69 constraint stated positively on both.
  it('both name a credit-card payment as one and tone it as neither spending nor income', () => {
    const [card, row] = bothWays({
      amount: -7866.69,
      pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
    })
    expect(card.category).toBe('Card payment')
    expect(row.category).toBe('Card payment')
    expect(card.tone).toBe('text-muted')
    expect(row.tone).toBe('text-muted')
    expect(card.amount).toBe('$7,866.69')
  })

  it('both offer the real category on an ordinary charge', () => {
    const [card, row] = bothWays({})
    expect(card.category).toBe('Food')
    expect(row.category).toBe('Food')
  })
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
