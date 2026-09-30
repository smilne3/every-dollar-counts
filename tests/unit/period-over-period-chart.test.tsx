import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { PeriodOverPeriodChart } from '@/components/PeriodOverPeriodChart'
import { CHART_SERIES } from '@/lib/chart-palette'

// Auto-cleanup only registers when vitest runs with globals; this suite does not.
afterEach(cleanup)

// Everything this suite reaches into on HTMLElement.prototype, so afterAll can put it back.
const patched: [string, PropertyDescriptor | undefined][] = []
let realBoundingRect: typeof HTMLElement.prototype.getBoundingClientRect

beforeAll(() => {
  // recharts measures its container through ResizeObserver, which jsdom does not implement, and
  // reads a width jsdom always reports as 0. Without both, ResponsiveContainer renders nothing.
  const BOX = { width: 800, height: 340 }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        // Fire once, synchronously: the no-op observer never reports a size, so recharts keeps
        // its width at 0 and renders an empty container.
        this.cb([{ target: el, contentRect: BOX } as unknown as ResizeObserverEntry], this)
      }
      unobserve() {}
      disconnect() {}
    }
  )
  for (const [prop, value] of [
    ['clientWidth', BOX.width],
    ['offsetWidth', BOX.width],
    ['clientHeight', BOX.height],
    ['offsetHeight', BOX.height],
  ] as const) {
    patched.push([prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)])
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value })
  }
  realBoundingRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ ...BOX, top: 0, left: 0, right: BOX.width, bottom: BOX.height, x: 0, y: 0 }) as DOMRect
})

afterAll(() => {
  for (const [prop, descriptor] of patched) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
  }
  HTMLElement.prototype.getBoundingClientRect = realBoundingRect
  vi.unstubAllGlobals()
})

const data = [
  { category: 'Loan Payments', current: 3929.35, previous: 3929.35 },
  { category: 'Food & Drink', current: 260.75, previous: 64.2 },
]

describe('PeriodOverPeriodChart', () => {
  // The bars used to be keyed "This" and "Last", which were also the legend labels. Rolling
  // windows have no "this month" to refer to, so the legend has to name the actual periods (#67).
  it('names both windows in the legend', () => {
    render(
      <PeriodOverPeriodChart
        data={data}
        currentLabel="Aug 2026"
        previousLabel="Jul 2026"
      />
    )
    // Two instances render — the phone chart and the desktop one — and the box stub gives both a
    // width, so each draws its own legend. Both legends have to name both windows, hence 2 each.
    expect(screen.getAllByText('Aug 2026')).toHaveLength(2)
    expect(screen.getAllByText('Jul 2026')).toHaveLength(2)
  })

  // Both names reaching the legend is not enough — they have to name the RIGHT series. recharts
  // does not draw bars under jsdom, but each legend entry carries its series colour, so the
  // swatch is what ties a label to a series. The later month is the primary series, the earlier
  // one the comparison. Asserted through CHART_SERIES rather than hex literals: which series a
  // label belongs to is this test's business, and what those two colours ARE is pinned by
  // tests/unit/chart-palette.test.ts. The earlier month was #c9cec7 here until spec §5.1.
  //
  // Scoped to each chart rather than flattened across the container. Task 3 gave each breakpoint
  // its own chart and therefore its own legend, and a flat query over both is satisfied by
  // whichever instance is still correct — which let a fill swap in ONE of them through unnoticed.
  // Each chart has to name its series correctly on its own.
  it('gives each month the colour its own bar is drawn in', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={data} currentLabel="Aug 2026" previousLabel="Jul 2026" />
    )
    // `div.` qualified: the disclosure button also carries `md:hidden`, and only the wrapper is
    // meant here.
    const legendOf = (selector: string) =>
      Array.from(container.querySelectorAll(`${selector} .recharts-legend-item`)).map((li) => [
        li.querySelector('[fill]')?.getAttribute('fill'),
        li.textContent,
      ])

    const phone = legendOf('div.md\\:hidden')
    expect(phone).toHaveLength(2)
    expect(phone).toContainEqual([CHART_SERIES.primary, 'Aug 2026'])
    expect(phone).toContainEqual([CHART_SERIES.comparison, 'Jul 2026'])

    const desktop = legendOf('div.md\\:block')
    expect(desktop).toHaveLength(2)
    expect(desktop).toContainEqual([CHART_SERIES.primary, 'Aug 2026'])
    expect(desktop).toContainEqual([CHART_SERIES.comparison, 'Jul 2026'])
  })

  // §1.4: the vertical chart puts 26 bars in ~273px under 13 labels rotated -40°, which collide.
  // Horizontal bars need no rotated labels at all, so the collision goes away by construction
  // rather than by tuning font sizes (spec §5).
  it('renders a phone chart and a desktop chart, gated on the breakpoint', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={data} currentLabel="Sep" previousLabel="Aug" />
    )
    const classes = [...container.querySelectorAll('div')].map((d) => d.className)
    expect(classes).toContain('md:hidden')
    expect(classes.some((c) => c.includes('hidden') && c.includes('md:block'))).toBe(true)
  })

  // The desktop chart is unchanged, which means it keeps the rotated labels. If this ever stops
  // being true the desktop layout has been altered by a phone-only stage.
  it('keeps the rotated category labels on the desktop chart only', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={data} currentLabel="Sep" previousLabel="Aug" />
    )
    const desktop = container.querySelector('div.md\\:block')!
    const phone = container.querySelector('div.md\\:hidden')!
    expect(desktop.innerHTML).toContain('rotate(-40')
    expect(phone.innerHTML).not.toContain('rotate(-40')
  })

  it('puts every category it is given on the axis', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={data} currentLabel="Aug 2026" previousLabel="Jul 2026" />
    )
    // recharts word-wraps an axis tick into <tspan>s, so compare with whitespace removed rather
    // than coupling the assertion to how it chose to break the label.
    const squashed = (container.textContent ?? '').replace(/\s+/g, '')
    for (const d of data) expect(squashed).toContain(d.category.replace(/\s+/g, ''))
  })

  const many = Array.from({ length: 13 }, (_, i) => ({
    category: `Cat ${i}`,
    current: 100 - i,
    previous: 50,
  }))

  // NOTE — the phone chart's category LABELS cannot be asserted in jsdom, but its row COUNT can.
  // Task 3 established the first half: the shared beforeAll stub makes the legend measure 340px, so
  // the phone chart's plot height computes to 0 and its category ticks never render. Any
  // `phone.innerHTML` assertion about category names therefore passes whatever the code does.
  //
  // The row count is a different matter. The phone wrapper's inline height is
  // `Math.max(200, phoneRows.length * 56)`, computed in the component and never touched by the
  // layout, so it survives the collapse — see 'shows six categories plus Other' below. Mind the
  // 200px floor if you recompute it for a short list: below four rows the height stops tracking the
  // count and the assertion would no longer distinguish them. At 7 and 13 rows it is exact.
  // Together the cap is pinned by:
  //   - that height assertion, which reads the phone chart's ROW COUNT, before and after expanding,
  //     off a style the component derives from `phoneRows` — not off drawn bars, since jsdom draws
  //     none; it is the only assertion here that distinguishes a capped phone chart from an
  //     uncapped one;
  //   - the axis-domain assertion below, which sees that the folded Other row reached the chart;
  //   - capCategories' own tests (Task 2), which own the arithmetic and the default limit;
  //   - the control's label below, which only exists when a fold happened;
  //   - the desktop assertion below, whose ticks DO render (they lay out along the width).
  // What remains device-only is how it LOOKS: which names are on the axis and that they are legible.
  it('shows six categories plus Other, and all of them when expanded', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={many} currentLabel="Sep" previousLabel="Aug" />
    )
    // `div.` qualified: the disclosure button also carries `md:hidden`.
    const phoneHeight = () =>
      (container.querySelector('div.md\\:hidden') as HTMLElement).style.height
    // Six categories plus Other is seven rows at 56px.
    expect(phoneHeight()).toBe('392px')
    fireEvent.click(screen.getByRole('button', { name: 'Show all 13 categories' }))
    expect(phoneHeight()).toBe('728px')
  })

  it('leaves the desktop chart uncapped', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={many} currentLabel="Sep" previousLabel="Aug" />
    )
    const desktop = container.querySelector('div.md\\:block')!
    // recharts word-wraps an axis tick into <tspan>s, so `Cat 12` never appears as a literal
    // string in the markup — squash whitespace first, as 'puts every category it is given on the
    // axis' above already does.
    const squashed = (desktop.textContent ?? '').replace(/\s+/g, '')
    expect(squashed).toContain('Cat12')
    expect(squashed).not.toContain('Other')
  })

  // An honest jsdom foothold on the phone cap itself, found by diffing the phone wrapper's markup
  // with and without it. The category ticks do not render (see the NOTE), but the NUMERIC axis
  // domain does: a domain is computed from the values, not from the plot height. `Other` folds
  // Cat 6..Cat 12 into 637 for the current window, which is larger than any single category in
  // `many` (the largest is 100) — so a numeric tick above 100 can exist only if the folded row
  // reached the phone chart. Hand the phone chart `data` instead of `phoneRows` and its axis tops
  // out at $100 and this fails.
  it('scales the phone axis to the folded Other total', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={many} currentLabel="Sep" previousLabel="Aug" />
    )
    const phone = container.querySelector('div.md\\:hidden')!
    const ticks = [
      ...phone.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value'),
    ].map((t) => Number((t.textContent ?? '').replace(/[^0-9.]/g, '')))
    expect(ticks.length).toBeGreaterThan(0)
    expect(Math.max(...ticks)).toBeGreaterThan(100)
  })

  // The load-bearing cap assertion in jsdom, alongside the axis test above. The control renders ONLY
  // when capCategories returned an `other`, and its label names the full count — so it fails if the
  // cap is bypassed entirely, or if `data.length` is read from the capped list by mistake. It does
  // NOT pin the limit: the label names `data.length`, which reads the same for any limit below 13.
  // The limit itself is pinned by 'defaults to six' in tests/unit/trends-view.test.ts.
  it('offers a control naming how many are hidden', () => {
    render(<PeriodOverPeriodChart data={many} currentLabel="Sep" previousLabel="Aug" />)
    const control = screen.getByRole('button', { name: 'Show all 13 categories' })
    // The cap is phone-only, so the control has to be too: the desktop chart already draws every
    // category, and a "show all" beside it would claim to reveal something that is not hidden.
    // Asserted on the class because jsdom applies no Tailwind, so the breakpoint has no effect
    // here that a rendered-size assertion could see — same approach as the gating test above.
    expect(control.className.split(/\s+/)).toContain('md:hidden')
  })

  it('expands to every category when the control is used', () => {
    render(<PeriodOverPeriodChart data={many} currentLabel="Sep" previousLabel="Aug" />)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 13 categories' }))
    // Asserted on the control, not the phone chart's labels — see the NOTE above.
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
  })

  it('states its expanded state for assistive tech', () => {
    render(<PeriodOverPeriodChart data={many} currentLabel="Sep" previousLabel="Aug" />)
    const control = screen.getByRole('button', { name: 'Show all 13 categories' })
    expect(control.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(control)
    expect(screen.getByRole('button', { name: 'Show fewer' }).getAttribute('aria-expanded')).toBe('true')
  })

  // Six or fewer is already everything, so a control that reveals nothing must not appear.
  it('offers no control when nothing is hidden', () => {
    render(<PeriodOverPeriodChart data={many.slice(0, 6)} currentLabel="Sep" previousLabel="Aug" />)
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
  })
})
