import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { StatCard } from '@/components/ui/StatCard'

afterEach(cleanup)

// The §9 assertion: a formatting test, not a width one. This is the test that would have caught
// §1.3 regressing, because the tile — not the caller — now decides how many characters it shows.
describe('StatCard', () => {
  it('renders the hero figure exactly, cents and all', () => {
    render(<StatCard label="Net worth" amount={1182885.15} variant="hero" />)
    expect(screen.getByText('$1,182,885.15')).toBeTruthy()
  })

  // Net worth is the figure that clipped twice. It must never be the rounded one.
  it('never rounds the hero figure', () => {
    render(<StatCard label="Net worth" amount={1182885.15} variant="hero" />)
    expect(screen.queryByText('$1,182,885')).toBeNull()
  })

  // A compact tile carries BOTH: the rounded one for the phone, the exact one from md up. CSS
  // decides which is seen, so both are in the DOM and each must be the right string.
  it('carries a rounded figure and an exact one on a compact tile', () => {
    render(<StatCard label="Cash on hand" amount={34920.49} />)
    expect(screen.getByText('$34,920')).toBeTruthy()
    expect(screen.getByText('$34,920.49')).toBeTruthy()
  })

  it('hides the rounded figure from md up and the exact figure below it', () => {
    render(<StatCard label="Cash on hand" amount={34920.49} />)
    expect(screen.getByText('$34,920').className).toContain('md:hidden')
    expect(screen.getByText('$34,920.49').className).toContain('hidden')
  })

  it('defaults to compact when no variant is given', () => {
    render(<StatCard label="Spent" amount={8776.51} />)
    expect(screen.getByText('$8,777')).toBeTruthy()
  })

  it('names the tile', () => {
    render(<StatCard label="Saved this month" amount={5449} />)
    expect(screen.getByText('Saved this month')).toBeTruthy()
  })

  // The "Saved this month" tile turns red when negative. That rule used to live in the caller's
  // JSX, which is why the caller had to pre-format the figure in the first place.
  //
  // Asserted on `hero`, where the figure is a direct child of the toned wrapper. On a compact tile
  // getByText returns the inner md:hidden/hidden span, which carries no tone — the tone is declared
  // once on the wrapper so the rounded and exact strings cannot end up different colours.
  it('paints a coral figure when asked', () => {
    render(<StatCard label="Saved" amount={-120} variant="hero" tone="coral" />)
    expect(screen.getByText('-$120.00').className).toContain('text-coral')
  })

  it('renders a footnote when given one', () => {
    render(<StatCard label="Net worth" amount={10} foot={<span>Across 12 accounts</span>} />)
    expect(screen.getByText('Across 12 accounts')).toBeTruthy()
  })

  it('becomes a link when given an href', () => {
    render(<StatCard label="Cash" amount={10} href="/breakdown/cash" />)
    expect(screen.getByRole('link').getAttribute('href')).toBe('/breakdown/cash')
  })
})
