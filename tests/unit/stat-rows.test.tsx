import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { StatRows } from '@/components/ui/StatRows'

afterEach(cleanup)

// The phone layout of the dashboard's three supporting figures. Three tiles side by side gave each
// about 70px of text width at 390px, and the Saved tile wrapped its note over five lines and broke
// "-$13,995" after the minus. One card with a row per figure gives each figure and note the card's
// width between them, rather than a third of it.
const rows = [
  { label: 'Cash on hand', amount: 19039.2, href: '/breakdown/cash', foot: 'In 2 accounts' },
  { label: 'Spent in October', amount: 13995.48, href: '/breakdown/spent', foot: 'this month' },
  { label: 'Saved this month', amount: -13995.48, href: '/breakdown/saved', tone: 'coral' as const, foot: 'Avg $3,822/mo · 5 mo' },
]

describe('StatRows', () => {
  it('shows each figure rounded to whole dollars, with its note', () => {
    render(<StatRows rows={rows} />)
    expect(screen.getByText('$19,039')).toBeTruthy()
    expect(screen.getByText('-$13,995')).toBeTruthy()
    expect(screen.getByText('Avg $3,822/mo · 5 mo')).toBeTruthy()
  })

  // Each row still drills into its breakdown, as the tile did.
  it('links each row to its breakdown', () => {
    render(<StatRows rows={rows} />)
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(links).toEqual(['/breakdown/cash', '/breakdown/spent', '/breakdown/saved'])
  })

  // A figure must never break after its minus sign.
  it('keeps each figure on one line', () => {
    render(<StatRows rows={rows} />)
    expect(screen.getByText('-$13,995').className).toContain('whitespace-nowrap')
  })

  it('colours a figure coral only when asked', () => {
    render(<StatRows rows={rows} />)
    expect(screen.getByText('-$13,995').className).toContain('text-coral')
    expect(screen.getByText('$19,039').className).not.toContain('text-coral')
  })

  it('renders a row with no note as just its label and figure', () => {
    render(<StatRows rows={[{ label: 'Cash on hand', amount: 100, href: '/breakdown/cash' }]} />)
    const link = screen.getByRole('link', { name: /cash on hand.*\$100/i })
    // Label block holds the label alone: no empty note line beneath it.
    expect(link.firstElementChild!.childElementCount).toBe(1)
  })

  it('formats in the household currency', () => {
    render(<StatRows rows={[{ label: 'Cash on hand', amount: 1234.5, currency: 'EUR', href: '/breakdown/cash' }]} />)
    expect(screen.getByText('€1,235')).toBeTruthy()
  })

  // A screen reader hears the label and the figure together, not a bare number.
  it('names each link by its label and figure', () => {
    render(<StatRows rows={rows} />)
    expect(screen.getByRole('link', { name: /saved this month.*-\$13,995/i })).toBeTruthy()
  })
})
