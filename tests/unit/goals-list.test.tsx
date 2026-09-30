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

  it('does not floor the Goal field width below md', () => {
    const { container } = render(<GoalsList {...props} />)
    const label = container.querySelector('[data-goal-name-field]') as HTMLElement
    expect(label.className).toContain('md:min-w-[12rem]')
    expect(label.className.split(/\s+/)).not.toContain('min-w-[12rem]')
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
