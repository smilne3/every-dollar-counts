import { describe, it, expect } from 'vitest'
import { CHART_SERIES } from '@/lib/chart-palette'

describe('CHART_SERIES', () => {
  // §9: "a test asserting the chart constants are the validated pair, so a future colour change
  // has to be deliberate." These two hex values were measured together — changing either one
  // without re-measuring is what this test exists to stop.
  it('is the validated pair', () => {
    expect(CHART_SERIES.primary).toBe('#0e9f6e')
    expect(CHART_SERIES.comparison).toBe('#0369a1')
  })

  // The value this replaced. 1.56:1 against the surface, failing two palette checks — the whole
  // reason §5.1 exists. Named here so it cannot quietly come back.
  it('does not use the grey that failed contrast', () => {
    expect(Object.values(CHART_SERIES)).not.toContain('#c9cec7')
  })
})
