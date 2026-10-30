import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { StatCard } from '@/components/ui/StatCard'

afterEach(cleanup)

// The §9 assertion: a formatting test, not a width one. This is the test that would have caught
// §1.3 regressing, because the tile — not the caller — now decides how many characters it shows.
describe('StatCard', () => {
  // Net worth is the figure that clipped twice (§1.3), so every dollar of it shows: never "$1.18M".
  // Its cents went on 2026-10-23, when the owner reversed spec §4's exact net worth (#215).
  it('renders the hero figure in whole dollars, every one of them', () => {
    render(<StatCard label="Net worth" amount={1182885.15} variant="hero" />)
    expect(screen.getByText('$1,182,885')).toBeTruthy()
    expect(screen.queryByText('$1,182,885.15')).toBeNull()
  })

  // A compact tile is shown only from md up: below md the dashboard, its one caller, shows StatRows
  // instead (#136). Its figure is whole dollars, as the phone row's is, so the two layouts show the
  // same figure the same way (#215).
  it('shows a compact tile its figure in whole dollars', () => {
    render(<StatCard label="Cash on hand" amount={34920.49} />)
    expect(screen.getByText('$34,920')).toBeTruthy()
    expect(screen.queryByText('$34,920.49')).toBeNull()
  })

  // One string, with nothing in it hidden at any width: no md:hidden and md:inline pair.
  it('renders the compact figure as one string', () => {
    const { container } = render(<StatCard label="Cash on hand" amount={34920.49} />)
    const figure = container.querySelector('.tabular-nums')!
    expect(figure.children.length).toBe(0)
    expect(figure.textContent).toBe('$34,920')
  })

  // The desktop-unchanged constraint is this stage's hardest rule, and it is the one thing no
  // other test here can see — jsdom does no layout, so the class strings ARE the evidence.
  // Both variants must resolve to the pre-existing scale at md and above. The compact tile was
  // text-2xl from sm (640px) and text-3xl from lg; it is shown only from md up, so text-2xl and
  // lg:text-3xl give it the sizes it always had there.
  it('keeps the desktop type scale on both variants', () => {
    const { container: hero } = render(<StatCard label="Net worth" amount={1} variant="hero" />)
    const heroClasses = hero.querySelector('.tabular-nums')!.className.split(/\s+/)
    expect(heroClasses).toContain('md:text-2xl')
    expect(heroClasses).toContain('lg:text-3xl')
    cleanup()
    const { container: compact } = render(<StatCard label="Cash" amount={1} />)
    const compactClasses = compact.querySelector('.tabular-nums')!.className.split(/\s+/)
    expect(compactClasses).toContain('text-2xl')
    expect(compactClasses).toContain('lg:text-3xl')
  })

  // The md/lg segments above are what must NOT change; this pins the rest, the hero's size below
  // `md` included. Mutating hero's first segment to `text-xl` passed all 476 tests before this
  // existed, which would have silently undone §4's "larger than today".
  it('pins the figure classes of both variants', () => {
    const { container: hero } = render(<StatCard label="Net worth" amount={1} variant="hero" />)
    expect(hero.querySelector('.tabular-nums')!.className).toBe(
      'mt-2 font-semibold tracking-tight tabular-nums text-ink text-3xl md:text-2xl lg:text-3xl'
    )
    cleanup()
    const { container: compact } = render(<StatCard label="Cash" amount={1} />)
    expect(compact.querySelector('.tabular-nums')!.className).toBe(
      'mt-2 font-semibold tracking-tight tabular-nums text-ink text-2xl lg:text-3xl'
    )
  })

  it('defaults to compact when no variant is given', () => {
    const { container: unset } = render(<StatCard label="Spent" amount={8776.51} />)
    const figure = unset.querySelector('.tabular-nums')!
    expect(figure.textContent).toBe('$8,777')
    const asDefault = figure.className
    cleanup()
    const { container: compact } = render(<StatCard label="Spent" amount={8776.51} variant="compact" />)
    expect(asDefault).toBe(compact.querySelector('.tabular-nums')!.className)
  })

  // #215: a figure a few cents below zero is "$0", never "-$0".
  it('never shows "-$0"', () => {
    const { container } = render(<StatCard label="Saved this month" amount={-0.3} />)
    expect(container.querySelector('.tabular-nums')!.textContent).toBe('$0')
  })

  it('names the tile', () => {
    render(<StatCard label="Saved this month" amount={5449} />)
    expect(screen.getByText('Saved this month')).toBeTruthy()
  })

  // The "Saved this month" tile turns red when negative. That rule used to live in the caller's
  // JSX, which is why the caller had to pre-format the figure in the first place.
  it.each(['hero', 'compact'] as const)('paints a coral figure when asked, on a %s tile', (variant) => {
    render(<StatCard label="Saved" amount={-120} variant={variant} tone="coral" />)
    expect(screen.getByText('-$120').className.split(/\s+/)).toContain('text-coral')
  })

  it('renders a footnote when given one', () => {
    render(<StatCard label="Net worth" amount={10} foot={<span>Across 12 accounts</span>} />)
    expect(screen.getByText('Across 12 accounts')).toBeTruthy()
  })

  it('becomes a link when given an href', () => {
    render(<StatCard label="Cash" amount={10} href="/breakdown/cash" />)
    expect(screen.getByRole('link').getAttribute('href')).toBe('/breakdown/cash')
  })

  // The link wraps the whole tile and was tall from the Card inside it alone. It carries a 44px floor
  // below md itself (#122), released from md up so the desktop grid is as it was.
  it('gives the link a 44px floor below md', () => {
    render(<StatCard label="Cash" amount={10} href="/breakdown/cash" />)
    expect(screen.getByRole('link').className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-[44px]', 'md:min-h-0']))
  })
})
