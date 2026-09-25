import { describe, it, expect } from 'vitest'
import { money } from '@/lib/format'
import { presentTransaction } from '@/lib/transaction-presentation'

const base = {
  amount: 100,
  name: 'JOE S DEN',
  merchant_name: 'Joe S Den' as string | null,
  user_category: null as string | null,
  pfc_primary: null as string | null,
  pfc_detailed: null as string | null,
  reimbursable_amount: null as number | null,
}

describe('presentTransaction', () => {
  // Moving money between two of your OWN accounts is not income and not spending. Plaid tags a
  // checking -> savings pair TRANSFER_IN / TRANSFER_OUT, which isCreditCardPayment never matched —
  // it only ever matched LOAN_PAYMENTS_CREDIT_CARD_PAYMENT. So a transfer in was toned `in` and
  // rendered emerald with a leading '+', reading as a paycheque arriving. Same failure as #31, one
  // category family over: the totals were right all along (lib/dashboard.ts skips transfers), the
  // READING was wrong.
  it('treats a transfer between your own accounts as internal', () => {
    expect(presentTransaction({ ...base, amount: -500, pfc_primary: 'TRANSFER_IN' }).isInternal).toBe(true)
    expect(presentTransaction({ ...base, amount: 500, pfc_primary: 'TRANSFER_OUT' }).isInternal).toBe(true)
  })

  it('tones both legs of a transfer as neither spending nor income', () => {
    expect(presentTransaction({ ...base, amount: -500, pfc_primary: 'TRANSFER_IN' }).tone).toBe('neutral')
    expect(presentTransaction({ ...base, amount: 500, pfc_primary: 'TRANSFER_OUT' }).tone).toBe('neutral')
  })

  // A card payment is internal too — isInternal is the superset, so one flag answers "is this your
  // own money moving?" for every surface that asks.
  it('counts a credit-card payment as internal as well', () => {
    const p = presentTransaction({ ...base, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })
    expect(p.isInternal).toBe(true)
    expect(p.isCC).toBe(true)
  })

  // The load-bearing distinction. isCC hides the category picker and the reimbursable controls
  // (TransactionRow.tsx:52,113 and TransactionCard.tsx:142) because those writes corrupt totals on
  // a card payment. A transfer has no such problem and must stay recategorizable, so widening isCC
  // would strip the picker off every transfer row.
  it('does not make a transfer look like a card payment', () => {
    const p = presentTransaction({ ...base, amount: -500, pfc_primary: 'TRANSFER_IN' })
    expect(p.isInternal).toBe(true)
    expect(p.isCC).toBe(false)
  })

  // Same override-wins contract isCreditCardPayment already honours: once a human has said what
  // this row is, respect it.
  it('lets a user override win over the transfer mapping', () => {
    const p = presentTransaction({
      ...base,
      amount: -500,
      pfc_primary: 'TRANSFER_IN',
      user_category: 'Income',
    })
    expect(p.isInternal).toBe(false)
    expect(p.tone).toBe('in')
  })

  it('leaves an ordinary inflow alone', () => {
    const p = presentTransaction({ ...base, amount: -1200, pfc_primary: 'INCOME' })
    expect(p.isInternal).toBe(false)
    expect(p.tone).toBe('in')
  })

  // Plaid: positive means money OUT. Every surface shows that as negative.
  it('flips Plaid sign for display', () => {
    expect(presentTransaction(base).display).toBe(-100)
    expect(presentTransaction({ ...base, amount: -250 }).display).toBe(250)
  })

  // -0 is not 0 for rendering: Intl formats it "-$0.00". Object.is, because `-0 === 0` is true and
  // a plain toBe(0) passes against the bug.
  it('renders a zero amount as zero, not as minus zero', () => {
    const p = presentTransaction({ ...base, amount: 0 })
    expect(Object.is(p.display, -0)).toBe(false)
    expect(p.display).toBe(0)
  })

  // A zero-amount transaction is neither spending nor income. Toned `in` it took the emerald the
  // list reserves for money arriving, plus RecentActivity's leading '+'.
  it('tones a zero amount as neither spending nor income', () => {
    expect(presentTransaction({ ...base, amount: 0 }).tone).toBe('neutral')
  })

  it('tones an outflow as ink and an inflow as emerald', () => {
    expect(presentTransaction(base).tone).toBe('out')
    expect(presentTransaction({ ...base, amount: -250 }).tone).toBe('in')
  })

  // The $7,866.69 case: money INTO the card is an inflow by sign, but it is your own
  // money moving between your own accounts and must never read as income.
  it('tones a credit-card payment neutral whichever way it points', () => {
    const cc = { ...base, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }
    expect(presentTransaction({ ...cc, amount: -7866.69 }).tone).toBe('neutral')
    expect(presentTransaction({ ...cc, amount: 7866.69 }).tone).toBe('neutral')
    expect(presentTransaction({ ...cc, amount: -7866.69 }).isCC).toBe(true)
  })

  // A user override deliberately wins, which is what re-enters both legs into the totals.
  it('stops treating it as a card payment once the user overrides the category', () => {
    const p = presentTransaction({
      ...base,
      pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
      user_category: 'Shopping',
    })
    expect(p.isCC).toBe(false)
  })

  it('prefers the merchant name and falls back to the raw name', () => {
    expect(presentTransaction(base).label).toBe('Joe S Den')
    expect(presentTransaction({ ...base, merchant_name: null }).label).toBe('JOE S DEN')
  })

  it('reports no share when nothing is marked', () => {
    expect(presentTransaction(base).shareAmount).toBeNull()
  })

  // An outflow's share is money out (negative); an inflow's remainder is money in.
  it('signs the share to match the display convention', () => {
    expect(presentTransaction({ ...base, amount: 100, reimbursable_amount: 40 }).shareAmount).toBe(-60)
    expect(presentTransaction({ ...base, amount: -100, reimbursable_amount: 40 }).shareAmount).toBe(60)
  })

  // A NaN here used to read as "nothing is marked": `marked > 0` is false, shareAmount comes out
  // null, and both surfaces then draw a broken value as a perfectly ordinary one. The reader has
  // no way at all to tell it from a transaction nobody ever ticked.
  //
  // Not reachable today — the column is numeric with a CHECK and the only writer clamps — but this
  // module's whole job is being the authoritative answer, and it added no validation over the
  // pattern it consolidated. Throwing is the choice this repo already makes when it cannot vouch
  // for a number: the transactions page throws rather than let "no transactions" and "we could not
  // read your transactions" look the same (#46). It takes out the list, which is the point; a
  // wrong share the household believes is the worse outcome.
  describe('an unreadable reimbursable_amount', () => {
    const unreadable = [
      { what: 'a non-numeric string', value: 'forty' as unknown as number },
      { what: 'NaN itself', value: NaN },
      { what: 'Infinity', value: Infinity },
    ]

    for (const { what, value } of unreadable) {
      it(`refuses ${what} rather than reporting the transaction as unmarked`, () => {
        expect(() => presentTransaction({ ...base, reimbursable_amount: value })).toThrow(
          /reimbursable_amount/
        )
      })
    }

    // The message has to be enough to find the row and see what was in it. An error naming neither
    // is only marginally more useful than the silent wrong render it replaced.
    it('names the transaction and the value it could not read', () => {
      expect(() =>
        presentTransaction({ ...base, reimbursable_amount: 'forty' as unknown as number })
      ).toThrow(/Joe S Den.*forty|forty.*Joe S Den/)
    })

    // The guard must not widen into the ordinary cases: null and 0 are how "unmarked" is spelled.
    it('still treats null and zero as simply unmarked', () => {
      expect(presentTransaction({ ...base, reimbursable_amount: null }).shareAmount).toBeNull()
      expect(presentTransaction({ ...base, reimbursable_amount: 0 }).shareAmount).toBeNull()
    })
  })

  // Ticking the checkbox marks the WHOLE amount, so a zero share is the commonest state there is,
  // not an edge case. Negating a zero remainder produces -0, which Intl renders as "-$0.00" — on
  // the card's meta line and in its accessible name both.
  //
  // `-0 === 0` is true and `expect(-0).toBe(0)` passes (toBe is Object.is, but Vitest's diff for
  // -0 vs 0 is the only thing that would tell you), so the sign has to be asserted through
  // something that can actually see it: the rendered string, and Object.is.
  it('normalises a fully-marked transaction to a share of positive zero', () => {
    const out = presentTransaction({ ...base, amount: 100, reimbursable_amount: 100 })
    expect(money(out.shareAmount as number)).toBe('$0.00')
    expect(Object.is(out.shareAmount, -0)).toBe(false)

    const inflow = presentTransaction({ ...base, amount: -100, reimbursable_amount: 100 })
    expect(money(inflow.shareAmount as number)).toBe('$0.00')
  })
})
