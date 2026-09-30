import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { CategoryManager } from '@/components/CategoryManager'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

// One ordinary category and one whose name is long enough to squeeze the Save/Delete buttons off
// the right of a 390px row — the case §7 is about.
const props = {
  initialCategories: [
    { id: '1', name: 'Groceries', pfc_primary: 'FOOD_AND_DRINK' },
    { id: '2', name: 'Home improvement and garden supplies', pfc_primary: null },
  ],
  usage: {
    Groceries: { txns: 12, hasBudget: true },
    'Home improvement and garden supplies': { txns: 0, hasBudget: false },
  },
}

describe('CategoryManager', () => {
  // §7: the rename/delete controls must be reachable at 390px without horizontal scroll. The row
  // wraps below `md` so a long category name cannot push the buttons off-screen, and reverts to
  // one line above it.
  it('lets a category row wrap below md', () => {
    const { container } = render(<CategoryManager {...props} />)
    const row = container.querySelector('[data-category-row]') as HTMLElement
    expect(row.className).toContain('flex-wrap')
    expect(row.className).toContain('md:flex-nowrap')
  })

  it('does not cap the row width below md', () => {
    const { container } = render(<CategoryManager {...props} />)
    const row = container.querySelector('[data-category-row]') as HTMLElement
    expect(row.className).toContain('md:max-w-md')
    expect(row.className.split(/\s+/)).not.toContain('max-w-md')
  })

  // The add form sits in the same 390px column and holds the same shape — an input plus a button.
  // Split on whitespace for the same reason as above: a bare `not.toContain('max-w-md')` over the
  // whole string would also match the `md:max-w-md` this requires.
  it('lets the add form wrap below md', () => {
    const { container } = render(<CategoryManager {...props} />)
    const form = container.querySelector('form') as HTMLElement
    const classes = form.className.split(/\s+/)
    expect(classes).toContain('flex-wrap')
    expect(classes).toContain('md:flex-nowrap')
    expect(classes).toContain('md:max-w-md')
    expect(classes).not.toContain('max-w-md')
    // The form's own spacing from the list above it is unrelated to the breakpoint work.
    expect(classes).toContain('pt-3')
  })

  // Wrapping must not cost the row any of its content.
  it('still renders every category with its rename field and controls', () => {
    const { container } = render(<CategoryManager {...props} />)
    expect(container.querySelectorAll('[data-category-row]')).toHaveLength(2)
    expect(
      (screen.getByLabelText('Rename category Groceries') as HTMLInputElement).value
    ).toBe('Groceries')
    expect(screen.getByLabelText('Delete Home improvement and garden supplies')).toBeTruthy()
    expect(screen.getByLabelText('New category name')).toBeTruthy()
  })
})
