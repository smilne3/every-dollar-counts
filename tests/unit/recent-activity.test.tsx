import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RecentActivity, type ActivityItem } from '@/components/RecentActivity'
import { presentTransaction, TONE_CLASS } from '@/lib/transaction-presentation'

afterEach(cleanup)

// Build items the way the page does, so the test exercises the real seam rather than a
// hand-written fixture that could drift from it.
const item = (
  over: Partial<Parameters<typeof presentTransaction>[0]> & { id?: string } = {}
): ActivityItem => {
  const txn = {
    amount: 42,
    name: 'JOE S DEN',
    merchant_name: 'Joe S Den',
    user_category: null,
    pfc_detailed: null,
    reimbursable_amount: null,
    ...over,
  }
  const p = presentTransaction(txn)
  return {
    id: over.id ?? 't1',
    date: '2026-08-29',
    category: 'Food',
    label: p.label,
    display: p.display,
    tone: p.tone,
    isCC: p.isCC,
  }
}

describe('RecentActivity', () => {
  it('shows real income as arriving', () => {
    render(<RecentActivity items={[item({ amount: -1200 })]} />)
    expect(screen.getByText('+$1,200.00')).toBeTruthy()
  })

  it('does not dress a credit-card payment up as income', () => {
    render(
      <RecentActivity
        items={[item({ amount: -7866.69, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })]}
      />
    )
    expect(screen.queryByText('+$7,866.69')).toBeNull()
    expect(screen.getByText('$7,866.69')).toBeTruthy()
  })

  it('says a card payment is between your own accounts rather than naming a category', () => {
    render(
      <RecentActivity
        items={[item({ amount: -7866.69, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })]}
      />
    )
    expect(screen.getByText(/Between your accounts/)).toBeTruthy()
  })

  // The point of the fold: the list takes the merchant-name fallback from presentTransaction
  // rather than owning a fourth copy of it.
  it('names a transaction with no merchant the way every other surface does', () => {
    render(<RecentActivity items={[item({ merchant_name: null, name: null })]} />)
    expect(screen.getByText('Transaction')).toBeTruthy()
  })

  it('tones an outflow, an inflow and a card payment the way TONE_CLASS says', () => {
    render(
      <RecentActivity
        items={[
          item({ id: 'out', amount: 42 }),
          item({ id: 'in', amount: -42 }),
          item({ id: 'cc', amount: -42, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }),
        ]}
      />
    )
    expect(screen.getByText('-$42.00').className).toContain(TONE_CLASS.out)
    expect(screen.getByText('+$42.00').className).toContain(TONE_CLASS.in)
    expect(screen.getByText('$42.00').className).toContain(TONE_CLASS.neutral)
  })

  // The icon chip has its OWN palette — an outflow is coral here and `text-ink` in the figure — so
  // TONE_CLASS cannot stand in for it and nothing else in the codebase pins it. Swapping its `out`
  // and `in` entries left every other test in this file green, which is the whole reason this one
  // exists. The arrow is pinned with it: which way it points is the sign convention drawn as a
  // glyph, and jsdom sees only the path data.
  it('keeps its own icon palette, and points the arrow the way the money went', () => {
    const { container } = render(
      <RecentActivity
        items={[
          item({ id: 'out', amount: 42 }),
          item({ id: 'in', amount: -42 }),
          item({ id: 'cc', amount: -42, pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }),
        ]}
      />
    )
    const chips = Array.from(container.querySelectorAll('li > span'))
    expect(chips.map((c) => c.className.replace(/^.*place-items-center rounded-lg /, ''))).toEqual([
      'bg-coral-050 text-coral',
      'bg-emerald-050 text-emerald',
      'bg-surface-2 text-faint',
    ])
    // ArrowDownLeftIcon's second path; ArrowUpRightIcon's is 'M8 7h9v9'. Money arriving points in.
    const arrows = chips.map((c) => c.querySelector('path:nth-of-type(2)')?.getAttribute('d'))
    expect(arrows).toEqual(['M8 7h9v9', 'M16 17H7V8', 'M16 17H7V8'])
    // And the figure does NOT take the icon's colour: the two palettes disagree on purpose.
    expect(screen.getByText('-$42.00').className).not.toContain('text-coral')
  })

  // The rendering that catches the -0 trap: a plain toBe(0) on `display` passes against the bug,
  // and jsdom only ever shows it as the string in the figure.
  it('renders a zero-amount row without a plus sign or a minus zero', () => {
    render(<RecentActivity items={[item({ amount: 0 })]} />)
    expect(screen.getByText('$0.00')).toBeTruthy()
    expect(screen.queryByText('+-$0.00')).toBeNull()
    expect(screen.queryByText('-$0.00')).toBeNull()
  })

  it('says so when there is nothing to show', () => {
    render(<RecentActivity items={[]} />)
    expect(screen.getByText('No transactions yet.')).toBeTruthy()
  })
})
