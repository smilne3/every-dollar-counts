import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { CategoryPicker } from '@/components/CategoryPicker'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const props = {
  transactionId: 't1',
  value: 'Food & Drink',
  options: ['Food & Drink', 'Shopping', 'Travel'],
  label: 'Starbucks',
}

const select = () => screen.getByRole('combobox') as HTMLSelectElement

describe('CategoryPicker', () => {
  it('saves the chosen category', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
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

  // The #97 bug. The picker awaited the request and never looked at it, so a 400, an expired
  // session, a 500 and a dropped connection all took the success path: the spinner stopped,
  // router.refresh() ran, and the <select> snapped back to the old value explaining nothing.
  // An optimistic value that survives a rejection is a lie about what was saved.
  it('puts the category back when the server refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({ error: 'that is not one of your categories' }) }))
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
      vi.fn(async () => ({ ok: false, json: async () => ({ error: 'nope' }) }))
    )

    render(<CategoryPicker {...props} />)
    fireEvent.change(select(), { target: { value: 'Shopping' } })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(select().disabled).toBe(false)
  })

  it('clears a previous error once a save succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'nope' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))

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
})
