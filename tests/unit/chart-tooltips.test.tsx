import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'
import { SpendIncomeChart } from '@/components/SpendIncomeChart'
import { SpendByCategoryChart } from '@/components/SpendByCategoryChart'
import { PeriodOverPeriodChart } from '@/components/PeriodOverPeriodChart'

afterEach(cleanup)

// What each chart hands recharts' Tooltip, caught by a stand-in. A real tooltip shows only over a
// hovered bar, and recharts draws no bars under jsdom, so there is nothing here to hover.
type TooltipProps = { formatter?: (value: unknown) => unknown }
const tooltips = vi.hoisted(() => [] as TooltipProps[])
vi.mock('recharts', () => {
  const box = ({ children }: { children?: ReactNode }) => children ?? null
  const none = () => null
  return {
    ResponsiveContainer: box,
    BarChart: box,
    Bar: none,
    XAxis: none,
    YAxis: none,
    CartesianGrid: none,
    Legend: none,
    Tooltip: (props: TooltipProps) => {
      tooltips.push(props)
      return null
    },
  }
})
// The comparison chart mounts each layout's chart only once its box has a size, which jsdom never
// gives one.
vi.mock('@/components/ui/WhenSized', () => ({ WhenSized: ({ children }: { children: ReactNode }) => children }))

beforeEach(() => {
  tooltips.length = 0
})

// #215: the tooltips printed the raw value in a template string, so $1,234.50 read "$1,234.5" on the
// dashboard and "$1234.5" on Trends. They go through money(), whole dollars as every summary is.
describe('chart tooltips', () => {
  it.each([
    ["the dashboard's spending and income", <SpendIncomeChart key="a" data={[{ label: 'Sep', income: 1234.5, spending: 10 }]} />, 1],
    ["Trends' spending by category", <SpendByCategoryChart key="b" data={[{ category: 'Food', amount: 1234.5 }]} />, 1],
    [
      "Trends' comparison, on the phone and from md up",
      <PeriodOverPeriodChart key="c" data={[{ category: 'Food', current: 1234.5, previous: 0 }]} currentLabel="Sep" previousLabel="Aug" />,
      2,
    ],
  ])('show %s in whole dollars', (_, chart, count) => {
    render(chart)
    expect(tooltips).toHaveLength(count)
    for (const { formatter } of tooltips) {
      expect(formatter!(1234.5)).toBe('$1,235')
      expect(formatter!(-0.3)).toBe('$0')
    }
  })
})
