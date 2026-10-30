import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { BudgetEditor } from '@/components/BudgetEditor'
import { SAVE_TIMEOUT_MS } from '@/lib/save-response'
import {
  answering,
  badGateway,
  neverSettles,
  offline,
  redirectedToLogin,
  refused,
  saved,
  savedAt,
  unanswered,
  useFakeSaveClock,
} from './helpers/save-replies'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  refresh.mockClear()
})

// A spy, so a test can tell whether the page is told to reload.
const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

// Two categories, the second over its limit, so both the ordinary and the coral branch render.
// readAt is when the page read the limits, by the server's clock.
const props = {
  categoryNames: ['Groceries', 'Dining'],
  initialLimits: { Groceries: 400, Dining: 150 },
  readAt: 1_000,
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
    // The tracks are not the only thing desktop gets back. The stacked row needs the tighter
    // `gap-2` and `items-start`, so the row's original spacing and alignment now live behind `md`
    // — and dropping either changes the desktop row (12px gaps to 8px, centred to top-aligned)
    // while every phone-shaped assertion still passes.
    expect(row.className).toContain('md:gap-3')
    expect(row.className).toContain('md:items-center')
  })

  // The input is the control most squeezed by the old layout — 7rem inside a 390px row.
  //
  // `toContain('w-full')` alone would be vacuous here: the width comes from the shared `inputClass`,
  // which has carried `w-full` all along, so that half cannot fail. What this change actually did
  // was move the 7rem cap behind `md`, so the pairing is pinned as a pair — `md:w-28` present AND
  // no bare `w-28` reaching the phone. Split on whitespace because a plain `not.toContain('w-28')`
  // over the whole string would match the `md:w-28` we are requiring.
  it('gives the limit input the full width below md', () => {
    const { container } = render(<BudgetEditor {...props} />)
    const input = container.querySelector('input[type="number"]') as HTMLElement
    const classes = input.className.split(/\s+/)
    expect(classes).toContain('w-full')
    expect(classes).toContain('md:w-28')
    expect(classes).not.toContain('w-28')
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
    expect(screen.getByText('$210 spent').className).toContain('text-coral')
    expect((screen.getByLabelText('Dining monthly budget limit') as HTMLInputElement).value).toBe(
      '150'
    )
  })

  // #215: spend shows in whole dollars, so whether it is over is decided from the figure shown.
  // $500.40 against a $500 limit reads "$500 spent", and coral there would call $500 of $500 over.
  const groceries = (spent: number) => ({
    ...props,
    categoryNames: ['Groceries'],
    initialLimits: { Groceries: 500 },
    spend: { Groceries: spent },
  })
  const barOf = (container: HTMLElement) =>
    container.querySelector('[data-budget-row] .rounded-full .rounded-full') as HTMLElement

  it('does not call a category 40 cents over its limit over budget', () => {
    const { container } = render(<BudgetEditor {...groceries(500.4)} />)
    expect(screen.getByText('$500 spent').className).not.toContain('text-coral')
    expect(barOf(container).className).not.toContain('bg-coral')
    expect(barOf(container).className).toContain('bg-amber')
  })

  // 50 cents over shows "$501 spent", half away from zero, which is over.
  it('calls a category over budget once the figure shown is over', () => {
    const { container } = render(<BudgetEditor {...groceries(500.5)} />)
    expect(screen.getByText('$501 spent').className).toContain('text-coral')
    expect(barOf(container).className).toContain('bg-coral')
  })
})

// #162: save() never looked at the reply, so every save said "Saved.", a dropped connection froze
// the button on "Saving…", and the typed limits stayed on screen whatever the server had.
describe('BudgetEditor saves', () => {
  const limit = (c: string) => screen.getByLabelText(`${c} monthly budget limit`) as HTMLInputElement
  const button = () => screen.getByRole('button', { name: /Save budgets|Saving…/ }) as HTMLButtonElement
  // Raise Groceries to 500, clear Dining, and press Save budgets.
  function editAndSave() {
    fireEvent.change(limit('Groceries'), { target: { value: '500' } })
    fireEvent.change(limit('Dining'), { target: { value: '' } })
    fireEvent.click(button())
  }

  it('sends every category, a cleared limit as 0, then says Saved. and reloads', async () => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)
    render(<BudgetEditor {...props} />)
    editAndSave()
    expect(await screen.findByText('Saved.')).toBeTruthy()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/budgets')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      items: [
        { category: 'Groceries', monthly_limit: 500 },
        { category: 'Dining', monthly_limit: 0 },
      ],
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(button().textContent).toBe('Save budgets')
    expect(button().disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // A definite failure wrote nothing: say why under the button, keep what was typed for a retry,
  // and do not reload.
  it.each([
    ['a refusal', () => refused(500, 'The limits you cleared could not be removed. Please try again.'), 'The limits you cleared could not be removed. Please try again.'],
    ['a redirect to the login page', redirectedToLogin, 'Your session ended. Sign in again.'],
    ['a 200 without ok: true', () => new Response('{}', { headers: { 'content-type': 'application/json' } }), 'That could not be saved.'],
  ])('after %s, says why under the button and keeps what was typed', async (_, reply, message) => {
    vi.stubGlobal('fetch', answering(reply))
    render(<BudgetEditor {...props} />)
    editAndSave()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(message)
    // Under the button: after it in the page.
    expect(button().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText('Saved.')).toBeNull()
    expect(limit('Groceries').value).toBe('500')
    expect(limit('Dining').value).toBe('')
    expect(refresh).not.toHaveBeenCalled()
    expect(button().disabled).toBe(false)
  })

  // It may have saved, so nothing is reset: with no connection the reload may never come, and the
  // server's last limits put back would sit under "Showing the latest." while Save sent them again,
  // undoing a save that may have landed. Saving again is safe, since a save sets every limit and
  // adds nothing. The reload, when it comes, refills the limits nobody has touched since.
  it.each([
    ['a gateway error page', () => answering(badGateway)],
    ['a request that fails in flight', () => offline()],
    // The route's own answer when the database never answered its write (#173).
    ["the route's word that the database never answered", () => answering(unanswered)],
  ])('after %s, says it may not have saved, keeps what was typed and reloads', async (_, fetchMock) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    render(<BudgetEditor {...props} />)
    editAndSave()
    expect((await screen.findByRole('alert')).textContent).toBe('It may not have saved. Showing the latest.')
    expect(screen.queryByText('Saved.')).toBeNull()
    expect(limit('Groceries').value).toBe('500')
    expect(limit('Dining').value).toBe('')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(button().disabled).toBe(false)
    expect(logged).toHaveBeenCalledWith('[BudgetEditor] save failed', expect.anything())
  })

  // Whether or not it landed, the reload is the latest, and nothing was typed since the save.
  it.each([
    ["it did not land, and the server's limits come back unchanged", { Groceries: 400, Dining: 150 }, '400', '150'],
    ['it landed', { Groceries: 500 }, '500', ''],
  ])('after an unknown outcome, the reload shows the latest when %s', async (_, latest, groceries, dining) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', answering(badGateway))
    const { rerender } = render(<BudgetEditor {...props} />)
    editAndSave()
    await screen.findByRole('alert')
    rerender(<BudgetEditor {...props} initialLimits={latest} />)
    expect(limit('Groceries').value).toBe(groceries)
    expect(limit('Dining').value).toBe(dining)
  })

  it('with no reload after an unknown outcome, saving again sends what was typed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(saved())
    vi.stubGlobal('fetch', fetchMock)
    render(<BudgetEditor {...props} />)
    editAndSave()
    await screen.findByRole('alert')
    fireEvent.click(button())
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      items: [
        { category: 'Groceries', monthly_limit: 500 },
        { category: 'Dining', monthly_limit: 0 },
      ],
    })
  })

  // #162 (and #103): on a weak signal the button froze on "Saving…" until a reload.
  it('gives up on a request that never settles: says so, keeps what was typed, reloads and re-enables', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    render(<BudgetEditor {...props} />)
    editAndSave()
    expect(button().textContent).toBe('Saving…')
    expect(button().disabled).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    })
    expect(screen.getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
    expect(button().textContent).toBe('Save budgets')
    expect(button().disabled).toBe(false)
    expect(limit('Groceries').value).toBe('500')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  // The reload after a save, or after an unknown outcome, brings the server's limits. Seeded once,
  // the editor kept showing what was typed whatever the server held.
  it('shows the limits a reload brings', () => {
    const { rerender } = render(<BudgetEditor {...props} />)
    rerender(<BudgetEditor {...props} initialLimits={{ Groceries: 500 }} />)
    expect(limit('Groceries').value).toBe('500')
    expect(limit('Dining').value).toBe('')
  })

  // A limit changed mid-save was not what the request sent, so "Saved." sat beside a number the
  // server never got, and the reload then put the sent one back.
  it('disables every limit while a save is in flight, and re-enables them after', async () => {
    let settle!: (res: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (settle = resolve))))
    render(<BudgetEditor {...props} />)
    editAndSave()
    expect(limit('Groceries').disabled).toBe(true)
    expect(limit('Dining').disabled).toBe(true)
    settle(saved())
    await screen.findByText('Saved.')
    expect(limit('Groceries').disabled).toBe(false)
    expect(limit('Dining').disabled).toBe(false)
  })

  // Refilling every field wiped a limit edited after "Saved." but before the reload arrived.
  it('keeps a limit edited after the save when the reload arrives, and refills the rest', async () => {
    vi.stubGlobal('fetch', answering(saved))
    const { rerender } = render(<BudgetEditor {...props} />)
    fireEvent.change(limit('Groceries'), { target: { value: '500.50' } })
    fireEvent.click(button())
    await screen.findByText('Saved.')
    fireEvent.change(limit('Dining'), { target: { value: '175' } })
    // The reload brings what was saved, as the server stores it.
    rerender(<BudgetEditor {...props} initialLimits={{ Groceries: 500.5, Dining: 150 }} />)
    expect(limit('Groceries').value).toBe('500.5')
    expect(limit('Dining').value).toBe('175')
  })

  it("refills only the limits nobody has typed into when the server's limits change", () => {
    const { rerender } = render(<BudgetEditor {...props} />)
    fireEvent.change(limit('Groceries'), { target: { value: '500' } })
    // Dining changed on the other phone: 150 to 175.
    rerender(<BudgetEditor {...props} initialLimits={{ Groceries: 400, Dining: 175 }} />)
    expect(limit('Groceries').value).toBe('500')
    expect(limit('Dining').value).toBe('175')
  })

  // "Saved." only ever sits beside what was sent. The server writes a limit its own way (500.50 as
  // 500.5, a 0 as no limit), which is still what was sent.
  it('keeps Saved. when the reload brings what was saved, and drops it when the reload brings something else', async () => {
    vi.stubGlobal('fetch', answering(saved))
    const { rerender } = render(<BudgetEditor {...props} />)
    fireEvent.change(limit('Groceries'), { target: { value: '500.50' } })
    fireEvent.change(limit('Dining'), { target: { value: '0' } })
    fireEvent.click(button())
    await screen.findByText('Saved.')
    rerender(<BudgetEditor {...props} initialLimits={{ Groceries: 500.5 }} />)
    expect(limit('Groceries').value).toBe('500.5')
    expect(limit('Dining').value).toBe('')
    expect(screen.getByText('Saved.')).toBeTruthy()
    // The other phone saved over it.
    rerender(<BudgetEditor {...props} initialLimits={{ Groceries: 450 }} />)
    expect(limit('Groceries').value).toBe('450')
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  // min="0" does not stop a minus sign being typed, and a limit below zero used to read as "no
  // limit": the old one was deleted and the editor said "Saved.".
  it('refuses a negative limit: says so under the button and sends nothing', async () => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)
    render(<BudgetEditor {...props} />)
    fireEvent.change(limit('Dining'), { target: { value: '-50' } })
    fireEvent.click(button())
    expect((await screen.findByRole('alert')).textContent).toBe("Limits can't be negative.")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByText('Saved.')).toBeNull()
    expect(limit('Dining').value).toBe('-50')
    expect(button().disabled).toBe(false)
  })

  // Deleting setSaved(false) at the start of a save passed every test, and a second Save with
  // nothing edited then showed "Saved." beside its own error.
  it('drops Saved. when the next save, with nothing edited, fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(saved()).mockResolvedValueOnce(refused(500, 'That could not be saved. Please try again.'))
    )
    render(<BudgetEditor {...props} />)
    editAndSave()
    await screen.findByText('Saved.')
    fireEvent.click(button())
    expect((await screen.findByRole('alert')).textContent).toBe('That could not be saved. Please try again.')
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('clears an earlier error once a save succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(refused(500, 'That could not be saved. Please try again.')).mockResolvedValueOnce(saved())
    )
    render(<BudgetEditor {...props} />)
    editAndSave()
    await screen.findByRole('alert')
    fireEvent.click(button())
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // "Saved." beside a limit typed after the save would be the #162 lie again.
  it('stops saying Saved. once a limit is edited again', async () => {
    vi.stubGlobal('fetch', answering(saved))
    render(<BudgetEditor {...props} />)
    editAndSave()
    await screen.findByText('Saved.')
    fireEvent.change(limit('Groceries'), { target: { value: '600' } })
    await waitFor(() => expect(screen.queryByText('Saved.')).toBeNull())
  })
})

// #176: two quick saves, and the reload asked for after the first read the limits before the
// second was written. Refilled from it, the fields showed the first save's limits beside "Saved.",
// and the next Save sent them back, undoing the second. Times are the server's clock: the route says
// when it wrote (savedAt), and the page when it read (readAt). Groceries starts at 400, read at 1,000.
describe('BudgetEditor and a reload that read before the last save', () => {
  const limit = (c: string) => screen.getByLabelText(`${c} monthly budget limit`) as HTMLInputElement
  const button = () => screen.getByRole('button', { name: /Save budgets|Saving…/ }) as HTMLButtonElement
  // The limits the nth request sent.
  const sent = (fetchMock: ReturnType<typeof vi.fn>, n: number) => JSON.parse(fetchMock.mock.calls[n][1].body as string).items
  async function saveGroceries(value: string) {
    fireEvent.change(limit('Groceries'), { target: { value } })
    fireEvent.click(button())
    await screen.findByText('Saved.')
  }
  // The first save's reload: read at 2,500, after the first save (written at 2,000) and before the
  // second (written at 3,000).
  const firstReload = { readAt: 2_500, initialLimits: { Groceries: 500, Dining: 150 } }
  // A third category, Travel, with a limit of 300.
  const travel = { categoryNames: ['Groceries', 'Dining', 'Travel'], initialLimits: { Groceries: 400, Dining: 150, Travel: 300 } }

  it("keeps the second save's limit when the first save's reload lands after it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(savedAt(2_000)).mockResolvedValueOnce(savedAt(3_000)).mockResolvedValueOnce(savedAt(4_000))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<BudgetEditor {...props} />)
    await saveGroceries('500')
    await saveGroceries('600')
    rerender(<BudgetEditor {...props} {...firstReload} />)
    expect(limit('Groceries').value).toBe('600')
    expect(screen.getByText('Saved.')).toBeTruthy()
    fireEvent.change(limit('Dining'), { target: { value: '200' } })
    fireEvent.click(button())
    await screen.findByText('Saved.')
    expect(sent(fetchMock, 2)).toEqual([
      { category: 'Groceries', monthly_limit: 600 },
      { category: 'Dining', monthly_limit: 200 },
    ])
    expect(limit('Groceries').value).toBe('600')
  })

  // What Next 16.4.2 does with the same two saves: a reload's page that has not arrived when the next
  // reload is asked for is never shown, so the first save's reload reaches the editor while the second
  // save is still in flight.
  it("keeps the second save's limit when the first save's reload lands while it is in flight", async () => {
    let settle!: (res: Response) => void
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(savedAt(2_000))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve)))
      .mockResolvedValueOnce(savedAt(4_000))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<BudgetEditor {...props} />)
    await saveGroceries('500')
    fireEvent.change(limit('Groceries'), { target: { value: '600' } })
    fireEvent.click(button())
    rerender(<BudgetEditor {...props} {...firstReload} />)
    expect(limit('Groceries').value).toBe('600')
    settle(savedAt(3_000))
    await screen.findByText('Saved.')
    expect(limit('Groceries').value).toBe('600')
    fireEvent.change(limit('Dining'), { target: { value: '200' } })
    fireEvent.click(button())
    await screen.findByText('Saved.')
    expect(sent(fetchMock, 2)).toEqual([
      { category: 'Groceries', monthly_limit: 600 },
      { category: 'Dining', monthly_limit: 200 },
    ])
    expect(limit('Groceries').value).toBe('600')
  })

  // A refusal is not followed by a reload, so the first save's reload can still land after it. The
  // limits typed for the refused save were not stored: they are typing, which no reload overwrites.
  // After "The limits you cleared could not be removed", the raised ones were written, and the first
  // save's limits put back over them would have been sent again by the retry.
  it("keeps what was typed after a refusal when the first save's reload lands after it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(savedAt(2_000))
      .mockResolvedValueOnce(refused(500, 'The limits you cleared could not be removed. Please try again.'))
      .mockResolvedValueOnce(savedAt(4_000))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<BudgetEditor {...props} />)
    await saveGroceries('500')
    fireEvent.change(limit('Groceries'), { target: { value: '600' } })
    fireEvent.change(limit('Dining'), { target: { value: '' } })
    fireEvent.click(button())
    await screen.findByRole('alert')
    rerender(<BudgetEditor {...props} {...firstReload} />)
    expect(limit('Groceries').value).toBe('600')
    expect(limit('Dining').value).toBe('')
    fireEvent.click(button())
    await screen.findByText('Saved.')
    expect(sent(fetchMock, 2)).toEqual([
      { category: 'Groceries', monthly_limit: 600 },
      { category: 'Dining', monthly_limit: 0 },
    ])
  })

  // Only the fields the refused save sent go back: a category that arrived meanwhile was filled from
  // the server, and still follows it.
  it('keeps a category that arrived during a refused save following the server', async () => {
    let settle!: (res: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve))))
    const withTravel = { ...props, categoryNames: ['Groceries', 'Dining', 'Travel'] }
    const { rerender } = render(<BudgetEditor {...props} />)
    fireEvent.change(limit('Groceries'), { target: { value: '500' } })
    fireEvent.click(button())
    rerender(<BudgetEditor {...withTravel} readAt={1_500} initialLimits={{ Groceries: 400, Dining: 150, Travel: 300 }} />)
    settle(refused(500, 'That could not be saved. Please try again.'))
    await screen.findByRole('alert')
    // The other phone has set Travel to 350 since.
    rerender(<BudgetEditor {...withTravel} readAt={2_500} initialLimits={{ Groceries: 400, Dining: 150, Travel: 350 }} />)
    expect(limit('Travel').value).toBe('350')
    expect(limit('Groceries').value).toBe('500')
  })

  // A reload that lands while a save is in flight holds back every field the save sent, and nothing
  // reloads after a refusal. Applied once the save is refused, it brings the other phone's change to
  // the fields nobody typed into; left unapplied, the retry sent the old limit back over it.
  it('applies a reload that landed during a refused save once it is refused', async () => {
    let settle!: (res: Response) => void
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(savedAt(2_000))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve)))
      .mockResolvedValueOnce(savedAt(4_000))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<BudgetEditor {...props} {...travel} />)
    await saveGroceries('500')
    fireEvent.change(limit('Dining'), { target: { value: '200' } })
    fireEvent.click(button())
    // The first save's reload, read at 2,500: the other phone has set Travel to 350.
    rerender(<BudgetEditor {...props} {...travel} readAt={2_500} initialLimits={{ Groceries: 500, Dining: 150, Travel: 350 }} />)
    expect(limit('Travel').value).toBe('300')
    settle(refused(500, 'That could not be saved. Please try again.'))
    await screen.findByRole('alert')
    expect(limit('Travel').value).toBe('350')
    expect(limit('Dining').value).toBe('200')
    fireEvent.click(button())
    await screen.findByText('Saved.')
    expect(sent(fetchMock, 2)).toEqual([
      { category: 'Groceries', monthly_limit: 500 },
      { category: 'Dining', monthly_limit: 200 },
      { category: 'Travel', monthly_limit: 350 },
    ])
  })

  // Applied again after a refusal, the page is still only as new as its read: one made before the
  // last confirmed save refills nothing that save sent.
  it('does not apply a reload older than the last save once a later save is refused', async () => {
    let settle!: (res: Response) => void
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(savedAt(2_000))
        .mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve)))
    )
    const { rerender } = render(<BudgetEditor {...props} />)
    await saveGroceries('500')
    fireEvent.change(limit('Dining'), { target: { value: '200' } })
    fireEvent.click(button())
    // Read at 1,500, before the first save was written.
    rerender(<BudgetEditor {...props} readAt={1_500} initialLimits={{ Groceries: 400, Dining: 150 }} />)
    settle(refused(500, 'That could not be saved. Please try again.'))
    await screen.findByRole('alert')
    expect(limit('Groceries').value).toBe('500')
    expect(limit('Dining').value).toBe('200')
  })


  it("shows a change from the other phone once a reload read after the save, and drops Saved. beside it", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)))
    const { rerender } = render(<BudgetEditor {...props} />)
    await saveGroceries('500')
    // Read at 1,500, before the save.
    rerender(<BudgetEditor {...props} readAt={1_500} initialLimits={{ Groceries: 400, Dining: 150 }} />)
    expect(limit('Groceries').value).toBe('500')
    expect(screen.getByText('Saved.')).toBeTruthy()
    // Read at 2,500, after it: the other phone has set Dining to 175 since.
    rerender(<BudgetEditor {...props} readAt={2_500} initialLimits={{ Groceries: 500, Dining: 175 }} />)
    expect(limit('Groceries').value).toBe('500')
    expect(limit('Dining').value).toBe('175')
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('keeps a limit typed after the save, whichever reload lands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)))
    const { rerender } = render(<BudgetEditor {...props} />)
    await saveGroceries('500')
    fireEvent.change(limit('Dining'), { target: { value: '120' } })
    rerender(<BudgetEditor {...props} readAt={1_500} initialLimits={{ Groceries: 400, Dining: 150 }} />)
    expect(limit('Groceries').value).toBe('500')
    expect(limit('Dining').value).toBe('120')
    // The other phone has set Groceries to 450 since the save.
    rerender(<BudgetEditor {...props} readAt={2_500} initialLimits={{ Groceries: 450, Dining: 150 }} />)
    expect(limit('Groceries').value).toBe('450')
    expect(limit('Dining').value).toBe('120')
  })

  // The page takes its time before reading and the route after writing, so a read stamped in the
  // same millisecond as the write may still have read before it. The next reload brings anything newer.
  it('does not refill from a read stamped at the time of the save', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)))
    const { rerender } = render(<BudgetEditor {...props} />)
    await saveGroceries('500')
    rerender(<BudgetEditor {...props} readAt={2_000} initialLimits={{ Groceries: 400, Dining: 150 }} />)
    expect(limit('Groceries').value).toBe('500')
    rerender(<BudgetEditor {...props} readAt={2_001} initialLimits={{ Groceries: 450, Dining: 150 }} />)
    expect(limit('Groceries').value).toBe('450')
  })

  // A category added on the other phone was never sent from here, so any read can fill it. Left
  // blank, it would be sent as no limit by the next Save, deleting the limit it has. Filled while a
  // save is in flight, it was not sent by that save, so that save does not say "Saved." beside it.
  it('fills a category it has not shown before from any reload, and only a save that sent it says Saved.', async () => {
    let settle!: (res: Response) => void
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve)))
      .mockResolvedValueOnce(savedAt(3_000))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<BudgetEditor {...props} />)
    fireEvent.change(limit('Groceries'), { target: { value: '500' } })
    fireEvent.click(button())
    // Travel, added with a limit of 300 on the other phone, arrives while the save is in flight.
    rerender(
      <BudgetEditor
        {...props}
        categoryNames={['Groceries', 'Dining', 'Travel']}
        readAt={1_500}
        initialLimits={{ Groceries: 400, Dining: 150, Travel: 300 }}
      />
    )
    expect(limit('Groceries').value).toBe('500')
    expect(limit('Travel').value).toBe('300')
    settle(savedAt(2_000))
    await waitFor(() => expect(button().disabled).toBe(false))
    expect(screen.queryByText('Saved.')).toBeNull()
    fireEvent.click(button())
    await screen.findByText('Saved.')
    expect(sent(fetchMock, 1)).toContainEqual({ category: 'Travel', monthly_limit: 300 })
  })

  // A category deleted on the other phone leaves no field behind. Kept, its field counted as sent when
  // the category was added again during a save, and showed the deleted limit beside "Saved.", which
  // the next Save would have put back.
  it('forgets a category deleted on the other phone, so it comes back empty during a save', async () => {
    let settle!: (res: Response) => void
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve)))
      .mockResolvedValueOnce(savedAt(3_000))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<BudgetEditor {...props} {...travel} />)
    // Travel deleted on the other phone, and its limit with it.
    rerender(<BudgetEditor {...props} readAt={1_500} initialLimits={{ Groceries: 400, Dining: 150 }} />)
    fireEvent.change(limit('Groceries'), { target: { value: '500' } })
    fireEvent.click(button())
    // Added again with no limit, arriving while the save is in flight.
    rerender(<BudgetEditor {...props} {...travel} readAt={1_800} initialLimits={{ Groceries: 400, Dining: 150 }} />)
    expect(limit('Travel').value).toBe('')
    settle(savedAt(2_000))
    await waitFor(() => expect(button().disabled).toBe(false))
    expect(limit('Travel').value).toBe('')
    fireEvent.click(button())
    await screen.findByText('Saved.')
    expect(sent(fetchMock, 1)).toContainEqual({ category: 'Travel', monthly_limit: 0 })
  })

  it('takes the limit of a category deleted and added again on the other phone', () => {
    const { rerender } = render(<BudgetEditor {...props} {...travel} />)
    rerender(<BudgetEditor {...props} readAt={1_500} initialLimits={{ Groceries: 400, Dining: 150 }} />)
    // Added again, with a limit of 250.
    rerender(<BudgetEditor {...props} {...travel} readAt={2_000} initialLimits={{ Groceries: 400, Dining: 150, Travel: 250 }} />)
    expect(limit('Travel').value).toBe('250')
  })
})
