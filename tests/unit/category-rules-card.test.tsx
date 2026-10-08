import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { CategoryRulesCard, type RuleView, type RuleCategory } from '@/components/CategoryRulesCard'

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
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  refresh.mockClear()
})

const CATS: RuleCategory[] = [
  { id: 'c-food', name: 'Food & Drink', kind: 'spending' },
  { id: 'c-grocery', name: 'Grocery', kind: 'spending' },
  { id: 'c-income', name: 'Income', kind: 'income' },
  { id: 'c-tin', name: 'Transfer In', kind: 'transfer' },
]
const safeway = (over: Partial<RuleView> = {}): RuleView => ({
  id: 'r1', merchantLabel: 'Safeway', categoryId: 'c-grocery', categoryName: 'Grocery', origin: 'seeded',
  changed: 145, pickedByHand: 14, matching: 159, ...over,
})
const reply = (ok: boolean, body: unknown) => ({ ok, redirected: false, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body })

describe('CategoryRulesCard', () => {
  it('offers only categories of the same kind', () => {
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    const options = within(screen.getByRole('combobox', { name: 'Category for Safeway' })).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Food & Drink', 'Grocery'])
  })

  // Review Focus 4.
  it('stacks below sm and never truncates the count', () => {
    render(<CategoryRulesCard rules={[safeway({ merchantLabel: 'A very long merchant name that will not fit on a phone' })]} categories={CATS} />)
    const count = screen.getByText('145 transactions · 14 picked by hand')
    expect(count.className).toContain('whitespace-nowrap')
    expect(count.className).toContain('tabular-nums')
    expect(count.closest('.truncate')).toBeNull()
    // Exact: the closed Remove dialog also names the merchant, inside longer sentences.
    const label = screen.getByText('A very long merchant name that will not fit on a phone')
    expect(label.className).toContain('truncate')
    expect(label.getAttribute('title')).toBe('A very long merchant name that will not fit on a phone')
    expect(label.closest('li')?.className).toMatch(/flex-col.*sm:flex-row/)
  })

  it('omits the hand-pick count when it is zero', () => {
    render(<CategoryRulesCard rules={[safeway({ pickedByHand: 0 })]} categories={CATS} />)
    expect(screen.getByText('145 transactions')).toBeTruthy()
  })

  it('shows a rule with no current transactions as such', () => {
    render(<CategoryRulesCard rules={[safeway({ changed: 0, pickedByHand: 0, matching: 0 })]} categories={CATS} />)
    expect(screen.getByText('No current transactions · set up from your earlier picks')).toBeTruthy()
  })

  it('shows the empty state', () => {
    render(<CategoryRulesCard rules={[]} categories={CATS} />)
    expect(screen.getByText('Nothing learned yet. Pick a category on a transaction and the app will remember it for that merchant.')).toBeTruthy()
  })

  it('Changes with the category it was showing, and refreshes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(true, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-food' } })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/api/category-rules', expect.objectContaining({ method: 'PATCH' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: 'r1', categoryId: 'c-food', expectedCategoryId: 'c-grocery' })
  })

  it('rolls back with the route message on a refused Change, without refreshing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(false, { error: 'This rule just changed. Refresh and try again.' })))
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-food' } })
    expect((await screen.findByRole('alert')).textContent).toBe('This rule just changed. Refresh and try again.')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('c-grocery')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('rolls back on a redirected Change and says the session ended', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ...reply(true, { ok: true }), redirected: true }))
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-food' } })
    expect((await screen.findByRole('alert')).textContent).toBe('Your session ended. Sign in again.')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('c-grocery')
  })

  // The select shows the choice being saved until a refresh brings the server's category; after
  // that the server's value leads again, so a later change made elsewhere is not hidden behind a
  // stale choice, and an old alert does not outlive the refresh.
  it("follows the server's category after a refresh, dropping a stale choice and alert", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(true, { ok: true })))
    const { rerender } = render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-food' } })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    rerender(<CategoryRulesCard rules={[safeway({ categoryId: 'c-food', categoryName: 'Food & Drink' })]} categories={CATS} />)
    rerender(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('c-grocery')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(false, { error: 'This rule just changed. Refresh and try again.' })))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-food' } })
    await screen.findByRole('alert')
    rerender(<CategoryRulesCard rules={[safeway({ categoryId: 'c-food', categoryName: 'Food & Drink' })]} categories={CATS} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it("Remove's dialog omits zero counts and says the next pick teaches", () => {
    render(<CategoryRulesCard rules={[safeway({ pickedByHand: 0 })]} categories={CATS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Safeway rule' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(within(dialog).getByText('Remove the Safeway rule?')).toBeTruthy()
    expect(within(dialog).getByText('145 Safeway transactions go back to their bank’s category.')).toBeTruthy()
    expect(within(dialog).queryByText(/picked by hand|keep theirs/)).toBeNull()
    expect(within(dialog).getByText('The next category you pick for Safeway will teach the app again.')).toBeTruthy()
  })

  it("Remove's dialog explains a rule with no current transactions", () => {
    render(<CategoryRulesCard rules={[safeway({ changed: 0, pickedByHand: 0, matching: 0 })]} categories={CATS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Safeway rule' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(within(dialog).getByText('No Safeway transactions are showing right now — for example, if a bank is disconnected.')).toBeTruthy()
  })

  it('Removes with the category it was showing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(true, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Safeway rule' }))
    fireEvent.click(within(screen.getByRole('dialog', { hidden: true })).getByRole('button', { name: 'Remove', hidden: true }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: 'r1', expectedCategoryId: 'c-grocery' })
  })
})
