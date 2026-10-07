import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { CategoryPicker } from '@/components/CategoryPicker'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  refresh.mockClear()
})
// A real spy, not a bare closure. With `refresh: () => {}` no test can tell whether the list is ever
// told to reload, so deleting the call — or making it run on the failure path, where it races the
// optimistic revert — leaves the suite green.
const refresh = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const props = {
  transactionId: 't1',
  value: 'Food & Drink',
  options: ['Food & Drink', 'Shopping', 'Travel'],
  label: 'Starbucks',
}

const select = () => screen.getByRole('combobox') as HTMLSelectElement

describe('CategoryPicker', () => {
  it('saves the chosen category', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, redirected: false, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/transactions/categorize')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toEqual({ transactionId: 't1', category: 'Shopping' })
  })

  it('shows the new category immediately, before the request comes back', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    expect(select().value).toBe('Shopping')
  })

  // The only thing preventing a second change while the first is outstanding. Two overlapping saves
  // break the busy contract: the first response reports not-busy while the second is still in
  // flight, so the sheet becomes closable and unmounts the picker — the exact #97 discard.
  it('cannot be changed again while a save is in flight', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    expect(select().disabled).toBe(true)
  })

  it('tells the page to reload once the save lands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, redirected: false, json: async () => ({ ok: true }) }))

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  // A refresh on a refused save would race the revert: the server's value arrives and overwrites
  // the category the user is being shown an error about.
  it('does not reload the page when the save is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, redirected: false, json: async () => ({ error: 'nope' }) }))
    )

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(refresh).not.toHaveBeenCalled()
  })

  // The #97 bug. The picker awaited the request and never looked at it, so a 400, an expired
  // session, a 500 and a dropped connection all took the success path: the spinner stopped,
  // router.refresh() ran, and the <select> snapped back to the old value explaining nothing.
  // An optimistic value that survives a rejection is a lie about what was saved.
  it('puts the category back when the server refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, redirected: false, json: async () => ({ error: 'that is not one of your categories' }) }))
    )

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(select().value).toBe('Food & Drink')
  })

  // #98 gives the route two refusals worth reading aloud — a credit-card payment and an unknown
  // category. A generic "that could not be saved" would throw away the only part the user can act on.
  it('shows the reason the server gave', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        redirected: false,
        json: async () => ({ error: 'a credit-card payment moves money between your own accounts' }),
      }))
    )

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/credit-card payment/)
    )
  })

  it('puts the category back when the request never lands', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(select().value).toBe('Food & Drink')
  })

  // Disabled is for "in flight", not "has failed". Leaving it disabled after a rejection would
  // strand the user on the wrong category with no way to try again.
  it('is usable again after a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, redirected: false, json: async () => ({ error: 'nope' }) }))
    )

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(select().disabled).toBe(false)
  })

  it('clears a previous error once a save succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, redirected: false, json: async () => ({ error: 'nope' }) })
      .mockResolvedValueOnce({ ok: true, redirected: false, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    fireEvent.change(select(), { target: { value: 'Travel' } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  // The phone sheet unmounts its children when it closes, and React silently no-ops a setState on an
  // unmounted component — so without a way to tell the host a request is outstanding, a failure that
  // lands after the sheet is dismissed is discarded before it could ever be shown. Same contract
  // ReimbursableCheckbox already has; TransactionCard folds it into the `busy` that Dialog honours.
  it('tells its host while a save is in flight', async () => {
    const onBusyChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, redirected: false, json: async () => ({ ok: true }) }))

    render(<CategoryPicker {...props} onBusyChange={onBusyChange} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() => expect(onBusyChange).toHaveBeenCalledWith(false))
    expect(onBusyChange.mock.calls.map((c) => c[0])).toEqual([true, false])
  })

  it('reports it is no longer busy even when the save fails', async () => {
    const onBusyChange = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )

    render(<CategoryPicker {...props} onBusyChange={onBusyChange} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(onBusyChange.mock.calls.map((c) => c[0])).toEqual([true, false])
  })

  // A signed-out /api call is redirected to /login by proxy.ts, and fetch follows it to a 200 HTML
  // page. That is not a save.
  it('treats a redirected response as a failure, and does not refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, redirected: true, json: async () => ({ ok: true }) }))
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Your session ended. Sign in again.'))
    expect(select().value).toBe('Food & Drink')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('treats a response that is not JSON as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, redirected: false, json: async () => { throw new SyntaxError('html') } }))
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Your session ended. Sign in again.'))
    expect(select().value).toBe('Food & Drink')
  })

  it('needs ok: true in the body, not just a 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, redirected: false, json: async () => ({}) }))
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That could not be saved.'))
    expect(refresh).not.toHaveBeenCalled()
  })

  // Another household member, or a later PR's rule, changes the row; the refreshed page brings the
  // new value. The picker must show it, not the value it was mounted with (#102).
  it('follows the server when its value changes', () => {
    const { rerender } = render(<CategoryPicker {...props} />)
    rerender(<CategoryPicker {...props} value="Travel" />)
    expect(select().value).toBe('Travel')
  })

  it('clears its alert when the server value changes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, redirected: false, json: async () => ({ error: 'No.' }) }))
    const { rerender } = render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    rerender(<CategoryPicker {...props} value="Travel" />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // #50: on the desktop row an error must not add a line or shift the row. On a phone the sheet has
  // room, and the picker must stay full width. From md the alert floats below the select (absolute,
  // against the `md:relative` wrapper) rather than being truncated beside it, where a ~128px cell
  // left it no room to be read. jsdom does no layout, so these class names are the only evidence
  // available here; the layout itself was measured in Chromium.
  it('keeps select and alert in one wrapper: a column on phones, one line from md', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, redirected: false, json: async () => ({ error: 'No.' }) }))
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    const alert = await screen.findByRole('alert')
    const wrapper = select().parentElement!
    expect(alert.parentElement).toBe(wrapper)
    for (const c of ['flex', 'w-full', 'flex-col', 'md:relative', 'md:inline-flex', 'md:w-auto', 'md:max-w-full', 'md:flex-row', 'md:flex-nowrap']) {
      expect(wrapper.className.split(/\s+/)).toContain(c)
    }
    const alertClasses = alert.className.split(/\s+/)
    expect(alertClasses).toContain('md:absolute')
    expect(alertClasses).toContain('md:top-full')
    expect(alertClasses).not.toContain('md:truncate')
  })

  // A refresh can bring a new server value while a save is in flight. If that save then fails, the
  // picker must fall back to the server's current value, not the one it had when the user chose.
  it('falls back to the server value that arrived while the save was in flight', async () => {
    let reply!: (r: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise((res) => { reply = res })))
    const { rerender } = render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    rerender(<CategoryPicker {...props} value="Travel" />)
    reply({ ok: false, redirected: false, json: async () => ({ error: 'No.' }) })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('No.'))
    expect(select().value).toBe('Travel')
  })

  // An HTML error page from a failing server is a failed save, not an ended session.
  it('treats a non-OK response that is not JSON as a failed save, not an ended session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, redirected: false, json: async () => { throw new SyntaxError('html') } }))
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That could not be saved.'))
    expect(select().value).toBe('Food & Drink')
    expect(refresh).not.toHaveBeenCalled()
  })
})
