import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CategoryManager } from '@/components/CategoryManager'
import type { DeleteImpact } from '@/lib/category-views'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

// jsdom has no showModal()/close() on <dialog> (see tests/unit/confirm-dialog.test.tsx).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

const none: DeleteImpact = { uncategorized: 0, moved: [], movedMore: 0, rulesRemoved: 0, toSpending: 0 }

// One ordinary category and one whose name is long enough to squeeze the Save/Delete buttons off
// the right of a 390px row — the case §7 is about.
const props = {
  initialCategories: [
    { id: '1', name: 'Groceries', pfc_primary: 'FOOD_AND_DRINK' },
    { id: '2', name: 'Home improvement and garden supplies', pfc_primary: null },
  ],
  usage: {
    Groceries: { txns: 12, hasBudget: true, impact: none },
    'Home improvement and garden supplies': { txns: 0, hasBudget: false, impact: none },
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

const usageFor = (impact: Partial<typeof none>, hasBudget = false) => ({
  Grocery: { txns: 3, hasBudget, impact: { ...none, ...impact } },
})
const renderManager = (usage: ReturnType<typeof usageFor>) =>
  render(<CategoryManager initialCategories={[{ id: 'c-grocery', name: 'Grocery', pfc_primary: null }]} usage={usage} />)
const openDelete = (name: string) => fireEvent.click(screen.getByLabelText(`Delete ${name}`))

// #28 spec §8.4. The dialog used to say every row "will become Uncategorized", which was wrong for
// hand picks and rule-labelled rows: they move to another category.
describe('CategoryManager delete dialog', () => {
  it('says which rows become Uncategorized and where the rest move', () => {
    renderManager(usageFor({ uncategorized: 2, moved: [{ name: 'Food & Drink', count: 145 }], movedMore: 4 }))
    openDelete('Grocery')
    expect(screen.getByText(/2 transactions/).closest('p')?.textContent).toBe('2 transactions will become Uncategorized.')
    expect(screen.getByText(/145 transactions/).closest('p')?.textContent).toBe('145 transactions will move to Food & Drink.')
    expect(screen.getByText('And 4 more will move to other categories.')).toBeTruthy()
  })

  it('names the rules a delete removes', () => {
    renderManager(usageFor({ rulesRemoved: 2 }))
    openDelete('Grocery')
    expect(screen.getByText('2 merchant rules that file into Grocery will be removed.')).toBeTruthy()
  })

  it('agrees the verb when a delete removes one rule', () => {
    renderManager(usageFor({ rulesRemoved: 1 }))
    openDelete('Grocery')
    expect(screen.getByText('1 merchant rule that files into Grocery will be removed.')).toBeTruthy()
  })

  it('warns about spending only when rows would start counting as spending', () => {
    renderManager(usageFor({ uncategorized: 1, toSpending: 1 }))
    openDelete('Grocery')
    expect(screen.getByText('1 of these will start counting as spending.')).toBeTruthy()
    cleanup()
    renderManager(usageFor({ uncategorized: 1 }))
    openDelete('Grocery')
    expect(screen.queryByText(/start counting as spending/)).toBeNull()
  })

  it('says nothing moves when nothing does', () => {
    renderManager(usageFor({}))
    openDelete('Grocery')
    expect(screen.getByText('No transactions currently use this category.')).toBeTruthy()
  })
})
