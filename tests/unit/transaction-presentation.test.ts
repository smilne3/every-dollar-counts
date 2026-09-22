import { describe, it, expect } from 'vitest'
import { money } from '@/lib/format'
import { presentTransaction } from '@/lib/transaction-presentation'

const base = {
  amount: 100,
  name: 'JOE S DEN',
  merchant_name: 'Joe S Den' as string | null,
  user_category: null as string | null,
  pfc_detailed: null as string | null,
  reimbursable_amount: null as number | null,
}

describe('presentTransaction', () => {
  // Plaid: positive means money OUT. Every surface shows that as negative.
  it('flips Plaid sign for display', () => {
    expect(presentTransaction(base).display).toBe(-100)
    expect(presentTransaction({ ...base, amount: -250 }).display).toBe(250)
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
