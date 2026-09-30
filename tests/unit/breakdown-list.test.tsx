import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BreakdownList } from '@/components/BreakdownList'

afterEach(cleanup)

const rows = [
  { key: 'a', label: 'Capital One Checking', sub: 'depository', amount: 1234.56, currency: 'USD' },
  { key: 'b', label: 'A'.repeat(60), sub: null, amount: 78.9, currency: 'USD', owed: true },
]

describe('BreakdownList', () => {
  it('shows the label and the amount', () => {
    render(<BreakdownList rows={rows} />)
    expect(screen.getByText('Capital One Checking')).toBeTruthy()
    expect(screen.getByText('$1,234.56')).toBeTruthy()
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

  it('renders a liability as a negative', () => {
    render(<BreakdownList rows={rows} />)
    expect(screen.getByText('−$78.90')).toBeTruthy()
  })

  it('says so when there is nothing to show', () => {
    render(<BreakdownList rows={[]} />)
    expect(screen.getByText('Nothing to show here yet.')).toBeTruthy()
  })
})
