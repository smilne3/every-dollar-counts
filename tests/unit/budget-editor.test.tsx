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
    expect(screen.getByText(/\$210\.00 spent/).className).toContain('text-coral')
    expect((screen.getByLabelText('Dining monthly budget limit') as HTMLInputElement).value).toBe(
      '150'
    )
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
