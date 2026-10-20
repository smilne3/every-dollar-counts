import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { CategoryManager } from '@/components/CategoryManager'
import type { DeleteImpact } from '@/lib/category-views'
import { SAVE_TIMEOUT_MS } from '@/lib/save-response'
import {
  answering,
  badGateway,
  neverSettles,
  offline,
  redirectedToLogin,
  refused,
  saved,
  useFakeSaveClock,
} from './helpers/save-replies'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  refresh.mockClear()
})

// A spy, so a test can tell whether the list is told to reload.
const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

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

  // Rows that only move (none become Uncategorized) are still rows using the category.
  it('does not say nothing moves when rows move but none become Uncategorized', () => {
    renderManager(usageFor({ uncategorized: 0, moved: [{ name: 'Food & Drink', count: 145 }] }))
    openDelete('Grocery')
    expect(screen.getByText(/145 transactions/).closest('p')?.textContent).toBe('145 transactions will move to Food & Drink.')
    expect(screen.queryByText('No transactions currently use this category.')).toBeNull()
  })
})

// #147: call() counted any OK reply as saved, had no try/finally, so a dropped connection left every
// button disabled with nothing said, and the add form cleared the typed name before the reply.
describe('CategoryManager saves', () => {
  const newName = () => screen.getByLabelText('New category name') as HTMLInputElement
  const add = () => screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement
  const deleteGroceries = () => screen.getByLabelText('Delete Groceries') as HTMLButtonElement
  function confirmDeleteGroceries() {
    fireEvent.click(deleteGroceries())
    const dialog = screen.getByRole('dialog', { name: 'Delete “Groceries”?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
  }
  function addPets() {
    fireEvent.change(newName(), { target: { value: '  Pets ' } })
    fireEvent.click(add())
  }

  it('adds the trimmed name, says so, clears the field and reloads', async () => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)
    render(<CategoryManager {...props} />)
    addPets()
    expect(await screen.findByText('Added “Pets”.')).toBeTruthy()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/categories')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ name: 'Pets' })
    expect(newName().value).toBe('')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(add().disabled).toBe(false)
  })

  // The bug in #147: the name was cleared before the reply, so a failed add lost what was typed.
  it('keeps the typed name while the add is in flight', () => {
    vi.stubGlobal('fetch', neverSettles())
    render(<CategoryManager {...props} />)
    addPets()
    expect(newName().value).toBe('  Pets ')
    expect(add().disabled).toBe(true)
    expect(deleteGroceries().disabled).toBe(true)
  })

  // A name typed while the add was in flight is the person's next one, not the one that saved.
  it('leaves a name typed while the add was in flight', async () => {
    let settle!: (res: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (settle = resolve))))
    render(<CategoryManager {...props} />)
    addPets()
    fireEvent.change(newName(), { target: { value: 'Kids' } })
    settle(saved())
    expect(await screen.findByText('Added “Pets”.')).toBeTruthy()
    expect(newName().value).toBe('Kids')
  })

  // Nothing saved, or it may have: either way the name stays, and the message says which.
  it.each([
    ['a refusal', () => answering(() => refused(400, 'That name is already a category.')), 'That name is already a category.', 0],
    ['a redirect to the login page', () => answering(redirectedToLogin), 'Your session ended. Sign in again.', 0],
    ['a 200 without ok: true', () => answering(() => new Response('{}', { headers: { 'content-type': 'application/json' } })), 'That could not be saved.', 0],
    ['a gateway error page', () => answering(badGateway), 'It may not have saved. Showing the latest.', 1],
    ['a request that fails in flight', () => offline(), 'It may not have saved. Showing the latest.', 1],
  ])('after %s, keeps the typed name, says why and re-enables', async (_, fetchMock, message, reloads) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    render(<CategoryManager {...props} />)
    addPets()
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.queryByText(/Added/)).toBeNull()
    expect(newName().value).toBe('  Pets ')
    expect(add().disabled).toBe(false)
    expect(deleteGroceries().disabled).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(reloads)
  })

  it('gives up on a request that never settles: says so, reloads and re-enables every control', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    render(<CategoryManager {...props} />)
    addPets()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    })
    expect(screen.getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
    expect(add().disabled).toBe(false)
    expect(deleteGroceries().disabled).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('renames, says so and reloads; on a refusal keeps the typed name and says why', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(refused(400, 'That name is already a category.')).mockResolvedValueOnce(saved()))
    render(<CategoryManager {...props} />)
    // Queried afresh each time: a row that remounted would leave a stale element still saying "Food".
    const field = () => screen.getByLabelText('Rename category Groceries') as HTMLInputElement
    const save = () => within(field().closest('[data-category-row]') as HTMLElement).getByRole('button', { name: 'Save' })
    fireEvent.change(field(), { target: { value: 'Food' } })
    fireEvent.click(save())
    expect((await screen.findByRole('alert')).textContent).toBe('That name is already a category.')
    expect(field().value).toBe('Food')
    expect(refresh).not.toHaveBeenCalled()
    fireEvent.click(save())
    expect(await screen.findByText('Renamed to “Food”.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  // The Save button beside a rename field is disabled while any save is in flight. Enter in the field
  // has to wait too (#147), or a second request races the first: a rename sent mid-add, say.
  it('ignores Enter in a rename field while a save is in flight', () => {
    const fetchMock = neverSettles()
    vi.stubGlobal('fetch', fetchMock)
    render(<CategoryManager {...props} />)
    addPets()
    const field = screen.getByLabelText('Rename category Groceries') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'Food' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ name: 'Pets' })
  })

  const renameField = () => screen.getByLabelText(/^Rename category /) as HTMLInputElement
  function renameGroceriesTo(name: string) {
    const field = screen.getByLabelText('Rename category Groceries') as HTMLInputElement
    fireEvent.change(field, { target: { value: name } })
    fireEvent.click(within(field.closest('[data-category-row]') as HTMLElement).getByRole('button', { name: 'Save' }))
  }
  const onlyGroceries = [{ id: '1', name: 'Groceries', pfc_primary: 'FOOD_AND_DRINK' }]

  // Seeded once, the field kept the typed "Food" under "It may not have saved. Showing the latest."
  // even when the reload said "Groceries", so the rename looked done.
  it("shows the server's name again after a rename that may not have saved", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', answering(badGateway))
    const { rerender } = render(<CategoryManager initialCategories={onlyGroceries} />)
    renameGroceriesTo('Food')
    expect((await screen.findByRole('alert')).textContent).toBe('It may not have saved. Showing the latest.')
    expect(renameField().value).toBe('Groceries')
    // The reload still says Groceries: the rename did not land.
    rerender(<CategoryManager initialCategories={[{ ...onlyGroceries[0] }]} />)
    expect(renameField().value).toBe('Groceries')
  })

  it('shows a name the server now has: renamed on the other phone, or a rename that landed', async () => {
    vi.stubGlobal('fetch', answering(saved))
    const { rerender } = render(<CategoryManager initialCategories={onlyGroceries} />)
    renameGroceriesTo('  Food ')
    expect(await screen.findByText('Renamed to “Food”.')).toBeTruthy()
    rerender(<CategoryManager initialCategories={[{ ...onlyGroceries[0], name: 'Food' }]} />)
    expect(renameField().value).toBe('Food')
    rerender(<CategoryManager initialCategories={[{ ...onlyGroceries[0], name: 'Food & Groceries' }]} />)
    expect(renameField().value).toBe('Food & Groceries')
  })

  // An "Added …" left beside the next save's failure would claim that save worked too.
  it('clears an earlier success message once the next save fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(saved()).mockResolvedValueOnce(refused(400, 'That name is already a category.')))
    render(<CategoryManager {...props} />)
    addPets()
    expect(await screen.findByText('Added “Pets”.')).toBeTruthy()
    fireEvent.change(newName(), { target: { value: 'Groceries' } })
    fireEvent.click(add())
    expect((await screen.findByRole('alert')).textContent).toBe('That name is already a category.')
    expect(screen.queryByText('Added “Pets”.')).toBeNull()
  })

  it('deletes, says so and reloads', async () => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)
    render(<CategoryManager {...props} />)
    confirmDeleteGroceries()
    expect(await screen.findByText('Deleted “Groceries”.')).toBeTruthy()
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE')
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ id: '1' })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  // 404: the category is already gone (deleted on the other phone), so the list is stale. Show the
  // latest under the message, as Settings → Category rules does.
  it('says why and reloads when a delete is refused because the category is gone', async () => {
    vi.stubGlobal('fetch', answering(() => refused(404, 'That category no longer exists.')))
    render(<CategoryManager {...props} />)
    confirmDeleteGroceries()
    expect((await screen.findByRole('alert')).textContent).toBe('That category no longer exists.')
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })
})
