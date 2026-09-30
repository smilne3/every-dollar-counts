import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { GoalsList } from '@/components/GoalsList'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

// Two goals so a row renders, one of them complete, and one with a name long enough to lean on
// the row's truncation.
const props = {
  initialGoals: [
    { id: '1', name: 'Emergency fund', target_amount: 3000, saved_amount: 1200 },
    { id: '2', name: 'New roof and gutters replacement fund', target_amount: 500, saved_amount: 500 },
  ],
}

describe('GoalsList', () => {
  // The Goal field's min-w-[12rem] blocks the shrink that would otherwise let this row fit a
  // 390px screen beside the w-32 Target field. Below `md` the form stacks; above it, today's
  // side-by-side layout is restored exactly.
  it('stacks the add form below md', () => {
    const { container } = render(<GoalsList {...props} />)
    const form = container.querySelector('form') as HTMLElement
    expect(form.className).toContain('flex-col')
    expect(form.className).toContain('md:flex-row')
  })

  // Desktop output must not change, and the stacking rewrote the one class list that decides it.
  // Every class the form carried before is still here, with the two that only make sense on a row
  // moved behind `md`: `flex-wrap` (meaningless on a column) and `items-end` (which on a column is
  // the CROSS axis, so bare it would right-align and shrink-wrap both fields on a phone).
  //
  // `max-w-xl` is the one that would fail silently. Nothing about a phone depends on it — at 390px
  // the form is nowhere near 36rem — so dropping it breaks only the desktop, where the form would
  // widen to the full card. That is a Global Constraint violation no phone-shaped test can see,
  // which is exactly why it is asserted here.
  it('keeps every class the desktop form had, with the row-only ones behind md', () => {
    const { container } = render(<GoalsList {...props} />)
    const classes = (container.querySelector('form') as HTMLElement).className.split(/\s+/)
    expect(classes).toContain('max-w-xl')
    expect(classes).toContain('md:flex-wrap')
    expect(classes).toContain('md:items-end')
    // Neither row-only class may reach the phone. Split on whitespace, or the `md:` forms above
    // would satisfy these.
    expect(classes).not.toContain('flex-wrap')
    expect(classes).not.toContain('items-end')
  })

  it('does not floor the Goal field width below md', () => {
    const { container } = render(<GoalsList {...props} />)
    const label = container.querySelector('[data-goal-name-field]') as HTMLElement
    expect(label.className).toContain('md:min-w-[12rem]')
    expect(label.className.split(/\s+/)).not.toContain('min-w-[12rem]')
  })

  // §7 directly: a 128px Target field on a 390px screen is the other half of this row's problem,
  // and stacking the form does not fix it by itself — a `w-32` field in a column is still 128px of
  // a 390px width. It fills the width below `md` and the 8rem cap returns above it.
  it('lets the Target field fill the width below md', () => {
    const { container } = render(<GoalsList {...props} />)
    const label = container.querySelector('[data-goal-target-field]') as HTMLElement
    const classes = label.className.split(/\s+/)
    expect(classes).toContain('w-full')
    expect(classes).toContain('md:w-32')
    expect(classes).not.toContain('w-32')
  })

  // Guards Ruling 3: the goal rows were already compliant and this task must not disturb them.
  it('leaves the goal row progress bars full width', () => {
    const { container } = render(<GoalsList {...props} />)
    const bars = [...container.querySelectorAll('div')].filter(
      (d) => d.className.includes('rounded-full') && d.className.includes('w-full')
    )
    expect(bars.length).toBeGreaterThan(0)
  })

  // Stacking must not cost the form any of its fields, nor the list any of its goals.
  it('still renders both fields and every goal', () => {
    render(<GoalsList {...props} />)
    expect(screen.getByText('Goal')).toBeTruthy()
    expect(screen.getByText('Target')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add goal' })).toBeTruthy()
    expect(screen.getByText('Emergency fund')).toBeTruthy()
    expect(
      (screen.getByLabelText('Amount saved for Emergency fund') as HTMLInputElement).value
    ).toBe('1200')
  })
})
