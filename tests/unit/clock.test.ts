import { describe, it, expect } from 'vitest'
import { todayIn, hourIn, isValidTimeZone } from '@/lib/clock'

// The exact moment from the #73 screenshot: 8:10pm on Wednesday 2 September in US Eastern, which
// is already Thursday 3 September in UTC. The server said "Good morning, Thursday September 3".
const REPORTED = new Date('2026-09-03T00:10:00Z')

describe('todayIn', () => {
  it('gives the household its own calendar day, not the server\'s', () => {
    expect(todayIn('America/New_York', REPORTED)).toBe('2026-09-02')
    expect(todayIn('UTC', REPORTED)).toBe('2026-09-03')
  })

  it('works east of UTC as well as west', () => {
    // 9:10am on the 3rd in Tokyo — a day ahead of New York at the same instant.
    expect(todayIn('Asia/Tokyo', REPORTED)).toBe('2026-09-03')
  })

  it('zero-pads, so string comparison against a database date stays chronological', () => {
    expect(todayIn('UTC', new Date('2026-01-05T12:00:00Z'))).toBe('2026-01-05')
  })

  it('refuses an unknown zone rather than silently falling back to UTC', () => {
    expect(() => todayIn('Mars/Olympus_Mons', REPORTED)).toThrow(/unknown time zone/)
  })
})

describe('hourIn', () => {
  it('gives the household its own hour', () => {
    expect(hourIn('America/New_York', REPORTED)).toBe(20)
    expect(hourIn('UTC', REPORTED)).toBe(0)
  })

  // Some engines render midnight as "24" under hour12: false. A greeting keyed on `hour < 12`
  // would then say "Good evening" at midnight.
  it('reports midnight as 0, never 24', () => {
    expect(hourIn('UTC', new Date('2026-09-03T00:00:00Z'))).toBe(0)
  })

  it('refuses an unknown zone', () => {
    expect(() => hourIn('Nowhere/Special', REPORTED)).toThrow(/unknown time zone/)
  })
})

describe('isValidTimeZone', () => {
  it('accepts a real IANA zone', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
  })

  it('rejects anything Intl does not know', () => {
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone('America/New York')).toBe(false)
  })
})
