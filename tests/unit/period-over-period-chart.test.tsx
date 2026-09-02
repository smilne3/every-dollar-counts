import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { PeriodOverPeriodChart } from '@/components/PeriodOverPeriodChart'

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
        currentLabel="Last 30 days"
        previousLabel="Previous 30"
      />
    )
    expect(screen.getByText('Last 30 days')).toBeTruthy()
    expect(screen.getByText('Previous 30')).toBeTruthy()
    // "This"/"Last" must not survive anywhere as a series name.
    expect(screen.queryByText('This')).toBeNull()
  })

  it('puts every category it is given on the axis', () => {
    const { container } = render(
      <PeriodOverPeriodChart data={data} currentLabel="Last 30 days" previousLabel="Previous 30" />
    )
    // recharts word-wraps an axis tick into <tspan>s, so compare with whitespace removed rather
    // than coupling the assertion to how it chose to break the label.
    const squashed = (container.textContent ?? '').replace(/\s+/g, '')
    for (const d of data) expect(squashed).toContain(d.category.replace(/\s+/g, ''))
  })
})
