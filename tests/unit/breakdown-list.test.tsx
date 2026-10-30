import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BreakdownList } from '@/components/BreakdownList'

afterEach(cleanup)

const rows = [
  { key: 'a', label: 'Capital One Checking', sub: 'depository', amount: 1234.56, currency: 'USD' },
  { key: 'b', label: 'A'.repeat(60), sub: null, amount: 78.9, currency: 'USD', owed: true },
]

describe('BreakdownList', () => {
  // Whole dollars, as every summary is (#215).
  it('shows the label and the amount', () => {
    render(<BreakdownList rows={rows} />)
    expect(screen.getByText('Capital One Checking')).toBeTruthy()
    expect(screen.getByText('$1,235')).toBeTruthy()
  })

  // §3.1's shape, which §7 asks this page to match: a long label truncates rather than pushing the
  // amount off a 390px screen. This is a regression guard for behaviour that already exists — the
  // component was verified compliant rather than rewritten (Ruling 2).
  it('truncates a long label instead of displacing the amount', () => {
    render(<BreakdownList rows={rows} />)
    expect(screen.getByText('A'.repeat(60)).className).toContain('truncate')
  })

  it('keeps the text block shrinkable so truncation can engage', () => {
    const { container } = render(<BreakdownList rows={rows} />)
    const shrinkable = [...container.querySelectorAll('div')].filter((d) =>
      d.className.split(/\s+/).includes('min-w-0')
    )
    expect(shrinkable.length).toBeGreaterThan(0)
  })

  // "Amount on the right" is §3.1's defining property and the whole reason Ruling 2 found this
  // component already compliant — yet truncation and `min-w-0` alone do not produce it. Without
  // `justify-between` the amount sits immediately after the label instead of at the right edge,
  // and every other assertion here still passes. Reached through the text block's parent so the
  // two halves are pinned as one row: the shrinkable block on the left, the amount pushed right.
  it('pushes the amount to the right of the row', () => {
    const { container } = render(<BreakdownList rows={rows} />)
    const textBlock = [...container.querySelectorAll('div')].find((d) =>
      d.className.split(/\s+/).includes('min-w-0')
    ) as HTMLElement
    const row = textBlock.parentElement as HTMLElement
    expect(row.className).toContain('justify-between')
    expect(row.className).toContain('items-center')
    // The amount is that row's last child, not something nested back inside the text block.
    expect(row.lastElementChild!.textContent).toBe('$1,235')
  })

  it('renders a liability as a negative', () => {
    render(<BreakdownList rows={rows} />)
    expect(screen.getByText('−$79').className).toContain('text-coral')
  })

  // #215: a debt under 50 cents rounds to $0, and "−$0" in coral would be a debt of nothing. The
  // minus sign and the colour follow the figure shown.
  it('shows a debt that rounds to $0 as a plain $0', () => {
    render(<BreakdownList rows={[{ ...rows[1], amount: 0.3 }]} />)
    const amount = screen.getByText('$0')
    expect(amount.className).not.toContain('text-coral')
    expect(screen.queryByText('−$0')).toBeNull()
  })

  // From 50 cents, it rounds to a dollar owed, and is one.
  it('shows a debt of 50 cents as a dollar owed', () => {
    render(<BreakdownList rows={[{ ...rows[1], amount: 0.5 }]} />)
    expect(screen.getByText('−$1').className).toContain('text-coral')
  })

  // A row marked exact keeps its cents: the owed-to-you total, wherever it appears (owner decision,
  // 2026-10-30, #215). The rows beside it stay whole dollars.
  it('keeps the cents on a row marked exact, and only there', () => {
    render(
      <BreakdownList
        rows={[rows[0], { key: 'owed', label: 'Owed to you', amount: 12.34, currency: 'USD', exact: true }]}
      />
    )
    expect(screen.getByText('$12.34')).toBeTruthy()
    expect(screen.getByText('$1,235')).toBeTruthy()
  })

  // A total a few cents below zero, such as a month's saving, reads "$0", never "-$0".
  it('never shows a total of "-$0"', () => {
    render(<BreakdownList rows={rows} total={{ label: 'Saved this month', amount: -0.3, currency: 'USD' }} />)
    expect(screen.getByText('Saved this month').parentElement!.lastElementChild!.textContent).toBe('$0')
  })

  it('says so when there is nothing to show', () => {
    render(<BreakdownList rows={[]} />)
    expect(screen.getByText('Nothing to show here yet.')).toBeTruthy()
  })

  // A row that drills in is a 44px tap target below md by its own classes (#122), not only by the
  // row inside it, whose padding a later change could shrink. From md up the floor is released.
  it('gives a row that is a link a 44px floor below md', () => {
    render(<BreakdownList rows={[{ ...rows[0], href: '/transactions?account=a' }]} />)
    expect(screen.getByRole('link').className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-[44px]', 'md:min-h-0']))
  })
})
