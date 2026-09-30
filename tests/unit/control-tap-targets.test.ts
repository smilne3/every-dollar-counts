import { describe, it, expect } from 'vitest'
import { inputClass, selectClass } from '@/components/ui/styles'
import { buttonClass } from '@/components/ui/Button'

// §7: "Every form control goes full width with a minimum 44px tap height." Measured before this
// change: inputClass ≈38px (py-2 + text-sm), selectClass ≈34px (py-1.5), buttonClass 32px (h-8)
// and 40px (h-10). Every control in the app was under 44px on a phone, including the ones stages
// 1-4 shipped into the transactions sheet.
//
// Asserted on class strings because jsdom computes no layout — the same evidence stages 2-4 use
// for every other layout rule in this pass.
describe('control tap targets', () => {
  it('gives inputs a 44px minimum below md', () => {
    expect(inputClass).toContain('min-h-[44px]')
  })

  it('gives selects a 44px minimum below md', () => {
    expect(selectClass).toContain('min-h-[44px]')
  })

  // §7 also asks for full width, and selectClass was the one shared control without it. `inputClass`
  // has had `w-full` all along; a select sized to its content is the narrowest tap target in the app.
  it('gives selects the full width below md, and content width above it', () => {
    expect(selectClass).toContain('w-full')
    expect(selectClass).toContain('md:w-auto')
  })

  it('gives buttons a 44px minimum below md, at both sizes', () => {
    expect(buttonClass('primary', 'sm')).toContain('min-h-[44px]')
    expect(buttonClass('primary', 'md')).toContain('min-h-[44px]')
  })

  // Desktop must not change. The minimum is released at `md`, and the buttons restore the exact
  // heights they have today rather than merely dropping the floor.
  //
  // `md:min-h-0` on the BUTTONS is not decoration and not covered by the `md:h-*` assertions above:
  // `min-height` beats `height` in CSS, so a button left with `min-h-[44px] md:h-8` and no release
  // renders 44px on desktop, not the 32px it has always been — `md:h-8` present and desktop still
  // broken. Verified by mutation: without these two lines, dropping `md:min-h-0` from either size
  // leaves all six tests green.
  it('releases the minimum at md on every control', () => {
    expect(inputClass).toContain('md:min-h-0')
    expect(selectClass).toContain('md:min-h-0')
    expect(buttonClass('primary', 'sm')).toContain('md:h-8')
    expect(buttonClass('primary', 'md')).toContain('md:h-10')
    expect(buttonClass('primary', 'sm')).toContain('md:min-h-0')
    expect(buttonClass('primary', 'md')).toContain('md:min-h-0')
  })

  // The sm/md distinction must survive — it is what makes a compact button compact on desktop.
  it('keeps the two button sizes distinct above md', () => {
    expect(buttonClass('primary', 'sm')).not.toContain('md:h-10')
    expect(buttonClass('primary', 'md')).not.toContain('md:h-8')
  })
})
