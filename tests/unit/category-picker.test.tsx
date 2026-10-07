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

// The route always answers in JSON, so every stand-in for its reply carries that content type.
const JSON_TYPE = { 'content-type': 'application/json' }
const reply = (ok: boolean, body: unknown) => ({
  ok,
  redirected: false,
  headers: new Headers(JSON_TYPE),
  json: async () => body,
})

describe('CategoryPicker', () => {
  it('saves the chosen category', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(true, { ok: true }))
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(true, { ok: true })))

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  // A refresh on a refused save would race the revert: the server's value arrives and overwrites
  // the category the user is being shown an error about.
  it('does not reload the page when the save is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(false, { error: 'nope' }))
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
      vi.fn(async () => reply(false, { error: 'that is not one of your categories' }))
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
      vi.fn(async () => reply(false, { error: 'a credit-card payment moves money between your own accounts' }))
    )

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/credit-card payment/)
    )
  })

  // A rejected fetch does not mean nothing saved: on a phone the request can reach the server and
  // write, and only the reply is lost. So the picker says it does not know, drops its optimistic
  // choice and reloads, which shows whatever the server really has. Safe to reload here, because
  // the save is no longer in flight.
  it('says it may not have saved, and reloads, when the request never lands', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
    )
    expect(select().value).toBe('Food & Drink')
    expect(select().disabled).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith('[CategoryPicker] save failed', expect.any(Error))
    logged.mockRestore()
  })

  // Disabled is for "in flight", not "has failed". Leaving it disabled after a rejection would
  // strand the user on the wrong category with no way to try again.
  it('is usable again after a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(false, { error: 'nope' }))
    )

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(select().disabled).toBe(false)
  })

  it('clears a previous error once a save succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(false, { error: 'nope' }))
      .mockResolvedValueOnce(reply(true, { ok: true }))
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(true, { ok: true })))

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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, redirected: true, headers: new Headers(JSON_TYPE), json: async () => ({ ok: true }) })
    )
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Your session ended. Sign in again.'))
    expect(select().value).toBe('Food & Drink')
    expect(refresh).not.toHaveBeenCalled()
  })

  // The content type, not whether the body parses, says whose reply this is. A 200 that is not JSON
  // is a page the request was sent to instead of the route (the login page), so nothing was saved.
  it('treats a 200 that is not JSON as an ended session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        redirected: false,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        json: async () => ({ ok: true }),
      })
    )
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Your session ended. Sign in again.'))
    expect(select().value).toBe('Food & Drink')
    expect(refresh).not.toHaveBeenCalled()
  })

  // A 200 that says it is JSON is the route's own reply, and the route only answers 200 after the
  // write. A body that then fails to parse (cut off mid-transfer) leaves the save unknown, not failed.
  it('says it may not have saved, and reloads, when the route\'s 200 cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        redirected: false,
        headers: new Headers(JSON_TYPE),
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input')
        },
      })
    )
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
    )
    expect(select().value).toBe('Food & Drink')
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.mocked(console.error).mockRestore()
  })

  it('needs ok: true in the body, not just a 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(true, {})))
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(false, { error: 'No.' })))
    const { rerender } = render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    rerender(<CategoryPicker {...props} value="Travel" />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // The alert sits in flow under the select at every width. #50's one-line rule keeps routine taps
  // from shifting rows, but a failed save must be readable, and in the ~128px desktop cell every
  // no-growth layout hid it, covered the next row, or was clipped on the last row. So while an error
  // shows, the erroring row grows, by up to about four lines in the narrowest cell for the longest
  // message. jsdom does no layout, so these class names are the only evidence available here; the
  // layout itself was measured in Chromium.
  it('keeps select and alert in one wrapper: a column at every width, the alert in flow', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(false, { error: 'No.' })))
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    const alert = await screen.findByRole('alert')
    const wrapper = select().parentElement!
    expect(alert.parentElement).toBe(wrapper)
    const wrapperClasses = wrapper.className.split(/\s+/)
    for (const c of ['flex', 'w-full', 'flex-col', 'md:w-auto', 'md:max-w-full']) {
      expect(wrapperClasses).toContain(c)
    }
    for (const c of ['md:flex-row', 'md:inline-flex']) {
      expect(wrapperClasses).not.toContain(c)
    }
    const alertClasses = alert.className.split(/\s+/)
    for (const c of ['md:absolute', 'md:truncate']) {
      expect(alertClasses).not.toContain(c)
    }
  })

  // A refresh can bring a new server value while a save is in flight. If that save then fails, the
  // picker must fall back to the server's current value, not the one it had when the user chose.
  it('falls back to the server value that arrived while the save was in flight', async () => {
    let answer!: (r: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise((res) => { answer = res })))
    const { rerender } = render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    rerender(<CategoryPicker {...props} value="Travel" />)
    answer(reply(false, { error: 'No.' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('No.'))
    expect(select().value).toBe('Travel')
  })

  // An HTML error page from a failing server is a failed save, not an ended session.
  it('treats a non-OK response that is not JSON as a failed save, not an ended session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        redirected: false,
        headers: new Headers({ 'content-type': 'text/html' }),
        json: async () => {
          throw new SyntaxError('html')
        },
      })
    )
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That could not be saved.'))
    expect(select().value).toBe('Food & Drink')
    expect(refresh).not.toHaveBeenCalled()
  })

  // Only a 200 is uncertain. A refusal whose JSON body cannot be read was still a refusal: nothing
  // was written, so the server's value stands and there is nothing new to reload.
  it('treats a non-OK reply whose JSON cannot be read as a failed save', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        redirected: false,
        headers: new Headers(JSON_TYPE),
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input')
        },
      })
    )
    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That could not be saved.'))
    expect(select().value).toBe('Food & Drink')
    expect(refresh).not.toHaveBeenCalled()
  })
})
