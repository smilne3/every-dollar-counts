import { describe, it, expect } from 'vitest'
import { averageSaved, savedAverage } from '@/lib/dashboard'

// #126: "what do we typically save in a month?" One month is too noisy to answer it, and two kinds
// of month would answer it wrongly: the current one, which is still in progress (#65), and any month
// up to the one where every account's history has begun (lib/history-start.ts).

const flow = (key: string, income: number, spending: number) => ({
  key,
  label: key.slice(5),
  income,
  spending,
})

describe('averageSaved', () => {
  it('averages income minus spending over the complete months', () => {
    const r = averageSaved(
      [flow('2026-07', 9000, 7000), flow('2026-08', 9000, 5000), flow('2026-09', 9000, 6000), flow('2026-10', 100, 900)],
      { currentKey: '2026-10', historyStartKey: '2025-10' }
    )
    expect(r!.average).toBeCloseTo(3000, 2)
    expect(r!.months.map((m) => [m.key, m.saved])).toEqual([
      ['2026-07', 2000],
      ['2026-08', 4000],
      ['2026-09', 3000],
    ])
  })

  // A month in progress has its spending but not yet its last paycheck.
  it('leaves out the current month', () => {
    const r = averageSaved([flow('2026-09', 9000, 6000), flow('2026-10', 0, 5000)], {
      currentKey: '2026-10',
      historyStartKey: '2025-10',
    })
    expect(r!.months.map((m) => m.key)).toEqual(['2026-09'])
    expect(r!.average).toBeCloseTo(3000, 2)
  })

  // The month history becomes complete is partial, and months before it are missing whole
  // accounts: that is not a $0 month.
  it('leaves out the history-start month and anything before it', () => {
    const r = averageSaved(
      [flow('2025-09', 0, 0), flow('2025-10', 1000, 4000), flow('2025-11', 9000, 6000), flow('2025-12', 9000, 7000)],
      { currentKey: '2026-01', historyStartKey: '2025-10' }
    )
    expect(r!.months.map((m) => m.key)).toEqual(['2025-11', '2025-12'])
    expect(r!.average).toBeCloseTo(2500, 2)
  })

  it('includes a month that lost money, as a negative', () => {
    const r = averageSaved([flow('2026-08', 5000, 9000), flow('2026-09', 9000, 3000)], {
      currentKey: '2026-10',
      historyStartKey: '2025-10',
    })
    expect(r!.average).toBeCloseTo(1000, 2)
    expect(r!.months[0].saved).toBe(-4000)
  })

  it('uses at most the last six complete months', () => {
    const keys = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']
    const r = averageSaved(
      keys.map((k, i) => flow(k, 1000 * (i + 1), 0)),
      { currentKey: '2026-10', historyStartKey: '2025-10' }
    )
    expect(r!.months.map((m) => m.key)).toEqual(keys.slice(2))
    expect(r!.average).toBeCloseTo((3 + 4 + 5 + 6 + 7 + 8) * 1000 / 6, 2)
  })

  it('returns null when no month qualifies', () => {
    expect(
      averageSaved([flow('2025-10', 9000, 1000), flow('2025-11', 9000, 1000)], {
        currentKey: '2025-11',
        historyStartKey: '2025-10',
      })
    ).toBeNull()
  })

  it('returns null when there is no data at all', () => {
    expect(
      averageSaved([flow('2026-09', 0, 0)], { currentKey: '2026-10', historyStartKey: null })
    ).toBeNull()
  })
})

// The pages show the average, or say why there is none, from the history state (lib/history-start).
// One function, so the tile and the drill-down cannot word it differently.
describe('savedAverage', () => {
  const flows = [flow('2026-08', 9000, 6000), flow('2026-09', 9000, 4000), flow('2026-10', 0, 900)]

  it('averages once every bank\'s history is in', () => {
    const r = savedAverage(flows, '2026-10', { kind: 'ready', month: '2026-07' })
    expect(r).toMatchObject({ kind: 'average', average: 4000 })
  })

  it('names the bank it is waiting for', () => {
    const r = savedAverage(flows, '2026-10', { kind: 'pending', bank: 'Capital One' })
    expect(r).toEqual({ kind: 'unavailable', reason: expect.stringContaining("waiting for Capital One's") })
  })

  it('says when history is in but no full month has followed it yet', () => {
    const r = savedAverage(flows, '2026-10', { kind: 'ready', month: '2026-09' })
    expect(r).toEqual({ kind: 'unavailable', reason: expect.stringMatching(/not enough history yet/i) })
  })

  it('says when there are no transactions at all', () => {
    const r = savedAverage(flows, '2026-10', { kind: 'none' })
    expect(r).toEqual({ kind: 'unavailable', reason: expect.stringMatching(/no transactions yet/i) })
  })
})
