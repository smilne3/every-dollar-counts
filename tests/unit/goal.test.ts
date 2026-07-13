import { describe, it, expect } from 'vitest'
import { goalProgress } from '@/lib/goal'

describe('goalProgress', () => {
  it('is the ratio saved/target', () => {
    expect(goalProgress(1500, 3000)).toBe(0.5)
  })
  it('clamps to 1 when over target', () => {
    expect(goalProgress(4000, 3000)).toBe(1)
  })
  it('is 0 for a zero/negative target', () => {
    expect(goalProgress(10, 0)).toBe(0)
  })
  it('is 0 for negative saved', () => {
    expect(goalProgress(-5, 100)).toBe(0)
  })
})
