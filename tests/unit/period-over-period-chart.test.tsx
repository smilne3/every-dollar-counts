import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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
  it('gives each month the colour its own bar is drawn in', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={data} currentLabel="Aug 2026" previousLabel="Jul 2026" />
    )
    const legend = Array.from(container.querySelectorAll('.recharts-legend-item')).map((li) => [
      li.querySelector('[fill]')?.getAttribute('fill'),
      li.textContent,
    ])
    expect(legend).toContainEqual([CHART_SERIES.primary, 'Aug 2026'])
    expect(legend).toContainEqual([CHART_SERIES.comparison, 'Jul 2026'])
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
    const desktop = container.querySelector('.md\\:block')!
    const phone = container.querySelector('.md\\:hidden')!
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
})
