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
// The count line, found by its title: its text is split across unbreakable pieces (see below).
const countLine = () => screen.getByTitle(/^Transactions this rule files under /)
const reply = (ok: boolean, body: unknown, status = ok ? 200 : 409) => ({ ok, status, redirected: false, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body })

describe('CategoryRulesCard', () => {
  it('offers only categories of the same kind', () => {
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    const options = within(screen.getByRole('combobox', { name: 'Category for Safeway' })).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Food & Drink', 'Grocery'])
  })

  // Review Focus 4.
  it('stacks below sm and never truncates the count', () => {
    render(<CategoryRulesCard rules={[safeway({ merchantLabel: 'A very long merchant name that will not fit on a phone' })]} categories={CATS} />)
    const line = countLine()
    expect(line.textContent).toBe('145 transactions · 14 picked by hand')
    expect(line.closest('.truncate')).toBeNull()
    // Each piece is unbreakable and tabular; the line may break only between them, at " · ".
    const pieces = [...line.querySelectorAll('.whitespace-nowrap.tabular-nums')]
    expect(pieces.map((el) => el.textContent)).toEqual(['145 transactions ·', '14 picked by hand'])
    // Exact: the closed Remove dialog also names the merchant, inside longer sentences.
    const label = screen.getByText('A very long merchant name that will not fit on a phone')
    expect(label.className).toContain('truncate')
    expect(label.getAttribute('title')).toBe('A very long merchant name that will not fit on a phone')
    const li = label.closest('li')!
    expect(li.className).toMatch(/flex-col.*sm:flex-row/)
    // Lets the controls, and the alert, drop to their own line rather than squeeze the text to 0px (1280px, Chromium).
    expect(li.className).toContain('sm:flex-wrap')
    // Keeps ~298px for the longest count beside the controls; without it the count ran under them at 640-900px.
    expect(label.parentElement!.className).toContain('sm:flex-[1_0_19rem]')
    // Caps the select at 192px from md up, where selectClass's md:w-auto let a long category name widen it.
    expect(screen.getByRole('combobox').className).toContain('md:max-w-48')
  })

  // Until PR 3 adds learning, the card must not promise it.
  it('explains rules without promising learning', () => {
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    expect(
      screen.getByText(
        "Each rule files one merchant's transactions under a category of your choosing, past and future. A rule never moves money between spending, transfers and income, and never touches card payments."
      )
    ).toBeTruthy()
    expect(screen.queryByText(/learn|teach|remember/i)).toBeNull()
  })

  it('omits the hand-pick count when it is zero', () => {
    render(<CategoryRulesCard rules={[safeway({ pickedByHand: 0 })]} categories={CATS} />)
    expect(countLine().textContent).toBe('145 transactions')
  })

  it('shows a rule with no current transactions as such', () => {
    render(<CategoryRulesCard rules={[safeway({ changed: 0, pickedByHand: 0, matching: 0 })]} categories={CATS} />)
    const line = countLine()
    expect(line.textContent).toBe('No current transactions · set up from your earlier picks')
    // Wider than a 360px phone's content box on one line, so it must be able to break at " · ".
    expect(line.querySelectorAll('.whitespace-nowrap').length).toBe(2)
  })

  it('shows the empty state', () => {
    render(<CategoryRulesCard rules={[]} categories={CATS} />)
    expect(screen.getByText('No category rules yet.')).toBeTruthy()
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(false, { error: 'That category is not one of yours.' }, 400)))
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-food' } })
    expect((await screen.findByRole('alert')).textContent).toBe('That category is not one of yours.')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('c-grocery')
    expect(refresh).not.toHaveBeenCalled()
  })

  // 404 and 409 are the server saying this card is stale: keep its message and show the latest.
  it.each([404, 409])('shows the route message and refreshes on a %i refusal', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(false, { error: 'This rule just changed. Refresh and try again.' }, status)))
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-food' } })
    expect((await screen.findByRole('alert')).textContent).toBe('This rule just changed. Refresh and try again.')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('c-grocery')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('says it may not have saved, rolls back and refreshes when the request fails in flight', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-food' } })
    expect((await screen.findByRole('alert')).textContent).toBe('It may not have saved. Showing the latest.')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('c-grocery')
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.mocked(console.error).mockRestore()
  })

  it('disables the select and Remove while a Change is in flight', async () => {
    let settle: (v: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((r) => (settle = r))))
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c-food' } })
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Remove the Safeway rule' }) as HTMLButtonElement).disabled).toBe(true)
    settle(reply(true, { ok: true }))
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false))
    expect((screen.getByRole('button', { name: 'Remove the Safeway rule' }) as HTMLButtonElement).disabled).toBe(false)
  })

  // The FK deletes a rule with its category, so a rule whose category is gone raced a delete.
  it('asks for a reload instead of offering Change and Remove when the category was just deleted', () => {
    render(<CategoryRulesCard rules={[safeway({ categoryId: 'c-gone', categoryName: 'a deleted category' })]} categories={CATS} />)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove the Safeway rule' })).toBeNull()
    const note = screen.getByText(/^This category was just deleted\./)
    expect(note.textContent).toBe('This category was just deleted. Reload the page.')
    expect(note.className).toBe('text-xs text-muted')
    expect(screen.getByRole('link', { name: 'Reload the page.' }).getAttribute('href')).toBe('/settings')
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

  // Learning from a pick arrives in PR 3, which restores the "will teach the app again" line.
  it("Remove's dialog omits zero counts and promises no learning", () => {
    render(<CategoryRulesCard rules={[safeway({ pickedByHand: 0 })]} categories={CATS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Safeway rule' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(within(dialog).getByText('Remove the Safeway rule?')).toBeTruthy()
    expect(within(dialog).getByText('145 Safeway transactions go back to their bank’s category.')).toBeTruthy()
    expect(within(dialog).queryByText(/picked by hand|keep theirs/)).toBeNull()
    expect(within(dialog).queryByText(/teach|learn/)).toBeNull()
  })

  it("Remove's dialog speaks of one transaction, and one hand pick, in the singular", () => {
    render(<CategoryRulesCard rules={[safeway({ changed: 1, pickedByHand: 1, matching: 2 })]} categories={CATS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Safeway rule' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(within(dialog).getByText('1 Safeway transaction goes back to its bank’s category.')).toBeTruthy()
    expect(within(dialog).getByText('1 you picked by hand keeps its category.')).toBeTruthy()
  })

  it("Remove's dialog says how many hand picks keep theirs", () => {
    render(<CategoryRulesCard rules={[safeway()]} categories={CATS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the Safeway rule' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    expect(within(dialog).getByText('145 Safeway transactions go back to their bank’s category.')).toBeTruthy()
    expect(within(dialog).getByText('14 you picked by hand keep theirs.')).toBeTruthy()
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
