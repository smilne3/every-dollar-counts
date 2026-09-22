import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { TransactionCard } from '@/components/TransactionCard'
import { TransactionRow } from '@/components/TransactionRow'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
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
  // merchant + amount and nothing else. Cutting it back to exactly that left the whole suite
  // green, which is why this now asserts the content rather than only that a name exists.
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
// Each surface is read down to the five things that carry MEANING rather than markup — the label,
// the category, the amount text, the share text, and the tone class that says what KIND of money
// this is — and those are compared. The previous version compared the card's entire textContent
// against an amount scraped from the row, which the sheet's own `{date} · {money(display)}` line
// satisfied on its own: a wrong amount in the visible row still passed, on the sheet's copy.
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

  type Surface = { label: string; category: string; amount: string; share: string; tone: string }

  // The share used to be dropped by BOTH extractors — phone() split the meta line on ' · ' and
  // took [1], desktop()'s amount regex stopped before it — so the one field where the -0 bug lived
  // was the one field never diffed. The two files each hardcoded '-$60.00' instead, which means
  // editing one of them to a wrong value left the suite green.
  //
  // Scanning the whole surface for the claim, rather than a fixed position in it, is what lets the
  // same extractor read both: the card puts it on the meta line after the category, the row puts
  // it in the reserved line under the figure — and that row line does double duty as the card-
  // payment explainer, which is not a share and must not be read as one.
  function shareIn(text: string): string {
    return text.match(/your share -?\$[\d,]+\.\d{2}/)?.[0] ?? ''
  }

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
      share: shareIn(meta.textContent ?? ''),
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
      share: shareIn(cells[3].textContent ?? ''),
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
    // Ticking the box marks the WHOLE amount, so this is the commonest marked state there is — and
    // the most recently fixed regression in this codebase: the remainder is zero, and negating a
    // zero gave -0, which Intl renders as "-$0.00".
    { name: 'fully-marked charge', o: { reimbursable_amount: 100 } },
    // M5: the two surfaces used to disagree here — the card said "Transaction", the row rendered
    // the empty label — because presentTransaction returned null and each decided for itself.
    { name: 'transaction with no merchant and no name', o: { merchant_name: null, name: null } },
  ]

  for (const c of cases) {
    it(`agree on label, category, amount, share and tone for a ${c.name}`, () => {
      const [card, row] = bothWays(c.o)
      expect(card.label).toBe(row.label)
      expect(card.category).toBe(row.category)
      expect(card.amount).toBe(row.amount)
      expect(card.share).toBe(row.share)
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

  // Spelled out for the same reason as the card-payment case above: agreeing on '-$0.00' would
  // satisfy the loop while both surfaces were wrong, and this is the exact string the fix removed.
  it('both read a fully-marked share as zero rather than minus zero', () => {
    const [card, row] = bothWays({ amount: 100, reimbursable_amount: 100 })
    expect(card.share).toBe('your share $0.00')
    expect(row.share).toBe('your share $0.00')
  })

  it('both state the same share on a partly-marked charge', () => {
    const [card, row] = bothWays({ amount: 100, reimbursable_amount: 40 })
    expect(card.share).toBe('your share -$60.00')
    expect(row.share).toBe('your share -$60.00')
  })

  it('both offer the real category on an ordinary charge', () => {
    const [card, row] = bothWays({})
    expect(card.category).toBe('Food')
    expect(row.category).toBe('Food')
  })
})

// PER_PAGE is 200 and the CSS-only dual layout renders both presentations for every transaction,
// so anything mounted inside a closed sheet is mounted 200 times in every page's HTML, at every
// viewport. Measured with renderToStaticMarkup over 200 transactions and a realistic 19-category
// list: 1,756 KB with the sheet body mounted against 1,010 KB with it gated, on a pre-branch
// baseline of 778 KB. A card went from 55 elements to 10, and the page from 381 <dialog>s to 200.
//
// The visible row being mounted twice (~5 elements x 200) is inherent to the dual layout and is
// the accepted cost of spec §2.
describe('TransactionCard while closed', () => {
  it('mounts the sheet element but nothing inside it', () => {
    const { container } = renderCard()
    // The <dialog> itself stays: it is what gives the platform somewhere to restore focus from.
    expect(container.querySelectorAll('dialog')).toHaveLength(1)
    // ...and everything that made a closed sheet expensive is absent — the 19-option <select>,
    // the checkbox, and ReimbursableEditor's own second, nested <dialog>.
    expect(container.querySelector('dialog select')).toBeNull()
    expect(container.querySelector('dialog option')).toBeNull()
    expect(container.querySelector('dialog input')).toBeNull()
  })

  // A budget rather than an exact count, because the point is the order of magnitude: 55 elements
  // per row was 200 closed sheets in every page load. Measure before changing this number.
  it('costs about a row, not about a row plus a form', () => {
    const { container } = renderCard()
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(14)
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

// Closing the sheet UNMOUNTS its children — they are gated on `open` so that 200 closed sheets do
// not ship in every page's HTML. ReimbursableCheckbox.set() and ReimbursableEditor.save() both
// call setError() AFTER their await, and React silently no-ops a setState on an unmounted
// component. There is no client-side telemetry, so a save that failed in that window was recorded
// nowhere and shown to nobody: the user taps the tick, taps Done, and believes the mark happened.
//
// On a phone that is one thumb movement, and it is a regression THIS branch introduced — on the
// desktop row the checkbox is mounted for the life of the page, so its error stands until the
// reader navigates away.
//
// The fix is to refuse to close while a child's mutation is in flight, which is the only way the
// failure is guaranteed to have somewhere to render when it arrives.
describe('TransactionCard sheet with a save in flight', () => {
  // A fetch the test settles by hand, so "in flight" is a state the test controls rather than
  // races. Resolving it is how the failure is delivered.
  function pendingFetch() {
    let settle!: (res: { ok: boolean; json: () => Promise<unknown> }) => void
    const fetchMock = vi.fn(() => new Promise((resolve) => { settle = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    return {
      refuse: () => settle({ ok: false, json: async () => ({ error: 'nope' }) }),
      accept: () => settle({ ok: true, json: async () => ({}) }),
    }
  }

  function openSheet(overrides: Partial<typeof txn> = {}) {
    render(
      <TransactionCard t={{ ...txn, ...overrides }} categoryName="Food" categoryOptions={['Food', 'Grocery']} />
    )
    fireEvent.click(screen.getByRole('button', { name: /edit/ }))
  }

  const done = () => screen.getByRole('button', { name: 'Done' })
  // `cancel` is Escape and the Android back gesture. It does not bubble in the DOM; React walks
  // the fiber tree anyway, so this is dispatched on the sheet's own <dialog>.
  const escape = () =>
    fireEvent(
      screen.getAllByRole('dialog')[0],
      new Event('cancel', { bubbles: false, cancelable: true })
    )

  it('will not close on Done while a reimbursable tick is still in flight', () => {
    pendingFetch()
    openSheet()
    fireEvent.click(screen.getByRole('checkbox'))

    fireEvent.click(done())

    // Still mounted — which is the only reason the failure below has anywhere to land.
    expect(screen.queryByRole('checkbox')).not.toBeNull()
  })

  it('shows the failure rather than discarding it when Done is tapped mid-save', async () => {
    const req = pendingFetch()
    openSheet()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(done())

    req.refuse()

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('nope'))
    // And the box is back where the server still has it, in front of the reader.
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('will not close on Escape while a reimbursable tick is still in flight', () => {
    pendingFetch()
    openSheet()
    fireEvent.click(screen.getByRole('checkbox'))

    escape()

    expect(screen.queryByRole('checkbox')).not.toBeNull()
  })

  it('closes again once the save has settled', async () => {
    const req = pendingFetch()
    openSheet()
    fireEvent.click(screen.getByRole('checkbox'))
    req.accept()
    await waitFor(() => expect((done() as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(done())

    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  // Same shape, the other child: ReimbursableEditor.save() also sets its error after the await.
  it('will not close while the partial-amount editor is saving', () => {
    pendingFetch()
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: /partial reimbursable amount/ }))
    fireEvent.change(screen.getByLabelText(/How much is coming back/), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    fireEvent.click(done())

    expect(screen.queryByRole('checkbox')).not.toBeNull()
  })

  // Holding someone inside a sheet they cannot leave would be a worse bug than the one above, so
  // the state that withholds the exit is tied to the controls that could have set it existing. A
  // refresh turning this row into a card payment removes both of them.
  it('does not lock the sheet shut when the controls disappear mid-flight', () => {
    pendingFetch()
    const { rerender } = render(
      <TransactionCard t={txn} categoryName="Food" categoryOptions={['Food']} />
    )
    fireEvent.click(screen.getByRole('button', { name: /edit/ }))
    fireEvent.click(screen.getByRole('checkbox'))
    expect((done() as HTMLButtonElement).disabled).toBe(true)

    rerender(
      <TransactionCard
        t={{ ...txn, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', amount: -7866.69 }}
        categoryName="Food"
        categoryOptions={['Food']}
      />
    )

    expect(screen.queryByRole('checkbox')).toBeNull()
    expect((done() as HTMLButtonElement).disabled).toBe(false)
  })

  // Nothing is in flight here, so the ordinary way out must be untouched.
  it('still closes on Done when no save is in flight', () => {
    openSheet()
    expect(screen.queryByRole('checkbox')).not.toBeNull()

    fireEvent.click(done())

    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
