import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { BudgetEditor } from '@/components/BudgetEditor'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

// Two categories, the second over its limit, so both the ordinary and the coral branch render.
const props = {
  categoryNames: ['Groceries', 'Dining'],
  initialLimits: { Groceries: 400, Dining: 150 },
  spend: { Groceries: 220, Dining: 210 },
}

describe('BudgetEditor', () => {
  // §7: below `md` a budget row is one line per field, not three columns in 390px. The grid
  // becomes a single column and reinstates the three tracks at `md`.
  it('stacks a budget row below md and restores the columns above it', () => {
    const { container } = render(<BudgetEditor {...props} />)
    const row = container.querySelector('[data-budget-row]') as HTMLElement
    expect(row.className).toContain('grid-cols-1')
    expect(row.className).toContain('md:grid-cols-[1fr_auto_7rem]')
  })

  // The input is the control most squeezed by the old layout — 7rem inside a 390px row.
  it('gives the limit input the full width below md', () => {
    const { container } = render(<BudgetEditor {...props} />)
    const input = container.querySelector('input[type="number"]') as HTMLElement
    expect(input.className).toContain('w-full')
    expect(input.className).toContain('md:w-28')
  })

  // §7 asks for "a full-width progress bar" below `md`. `max-w-xs` (20rem) capped it well short of
  // a 390px row, so it is released below `md` and restored above so desktop is unchanged.
  it('lets the progress bar fill the row below md and caps it above', () => {
    const { container } = render(<BudgetEditor {...props} />)
    const bar = container.querySelector('[data-budget-row] .rounded-full') as HTMLElement
    expect(bar.className).toContain('w-full')
    expect(bar.className).not.toContain(' max-w-xs')
    expect(bar.className).toContain('md:max-w-xs')
  })

  // The stacked layout must not cost any of the row's content — the fixture's over-limit category
  // is the one whose spent figure turns coral.
  it('still renders every category, its spend and its limit input', () => {
    const { container } = render(<BudgetEditor {...props} />)
    expect(container.querySelectorAll('[data-budget-row]')).toHaveLength(2)
    expect(screen.getByText('Groceries')).toBeTruthy()
    expect(screen.getByText(/\$210\.00 spent/).className).toContain('text-coral')
    expect((screen.getByLabelText('Dining monthly budget limit') as HTMLInputElement).value).toBe(
      '150'
    )
  })
})
