import { describe, it, expect } from 'vitest'
import { clampReimbursable } from '@/lib/reimbursements'

// The DB CHECK refuses anything above abs(amount). Clamping BEFORE the write turns a 500 from a
// constraint violation into the sensible answer, and is also what keeps a Plaid amount revision
// from wedging a row that was valid when it was marked.
describe('clampReimbursable', () => {
  it('passes a valid amount through', () => {
    expect(clampReimbursable(750, 1000)).toBe(750)
  })

  it('caps at the transaction amount', () => {
    expect(clampReimbursable(1500, 1000)).toBe(1000)
  })

  it('uses the magnitude, so an inflow can be marked', () => {
    expect(clampReimbursable(200, -260)).toBe(200)
    expect(clampReimbursable(500, -260)).toBe(260)
  })

  it('treats null as clearing the mark', () => {
    expect(clampReimbursable(null, 1000)).toBeNull()
  })

  // A zero or negative mark is not a mark. It must clear rather than violate the CHECK's `> 0`.
  it('clears rather than storing zero or a negative', () => {
    expect(clampReimbursable(0, 1000)).toBeNull()
    expect(clampReimbursable(-5, 1000)).toBeNull()
  })

  // A transaction's amount can be revised to 0 by Plaid (a voided or corrected transaction, a $0
  // hold) after it was already marked. Clamping to the transaction's magnitude must not resurface a
  // storable-looking 0 in that case: `Math.min(105, 0)` is 0, and 0 fails the CHECK's `> 0` just as
  // surely as a negative amount does. The clamp's job is "return a legally storable value or null,"
  // so this belongs in the function, not left for every call site to re-discover.
  it('clears rather than storing zero when the transaction amount is zero', () => {
    expect(clampReimbursable(105, 0)).toBeNull()
  })
})
