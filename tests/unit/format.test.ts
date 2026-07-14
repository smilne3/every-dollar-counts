import { describe, it, expect } from 'vitest'
import { axisTick } from '@/lib/format'

describe('axisTick', () => {
  it('keeps half-thousand gridlines honest', () => {
    // The regression: Math.round(v/1000) labelled these $0/$2k/$3k/$5k/$6k, so a bar
    // at 1500 sat on a line reading "$2k".
    expect([0, 1500, 3000, 4500, 6000].map(axisTick)).toEqual([
      '$0',
      '$1.5k',
      '$3k',
      '$4.5k',
      '$6k',
    ])
  })

  it('drops the trailing .0 on whole thousands', () => {
    expect(axisTick(2000)).toBe('$2k')
  })

  it('leaves sub-thousand ticks alone', () => {
    expect(axisTick(250)).toBe('$250')
    expect(axisTick(0)).toBe('$0')
  })
})
