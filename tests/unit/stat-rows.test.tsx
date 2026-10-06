import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { StatRows } from '@/components/ui/StatRows'

afterEach(cleanup)

// The phone layout of the dashboard's three supporting figures. Three tiles side by side gave each
// about 76px at 390px, and the Saved tile wrapped its note over five lines and broke "-$13,995"
// after the minus (seen on the owner's iPhone, 2026-10-06). One card with a row per figure gives
// every figure and note the full width.
const rows = [
  { label: 'Cash on hand', amount: 19039.2, href: '/breakdown/cash', foot: 'In 2 accounts' },
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
    expect(links).toEqual(['/breakdown/cash', '/breakdown/saved'])
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

  // A screen reader hears the label and the figure together, not a bare number.
  it('names each link by its label and figure', () => {
    render(<StatRows rows={rows} />)
    expect(screen.getByRole('link', { name: /saved this month.*-\$13,995/i })).toBeTruthy()
  })
})
