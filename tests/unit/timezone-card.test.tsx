import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { TimezoneCard } from '@/components/TimezoneCard'
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

// Auto-cleanup only registers when vitest runs with globals; this suite does not.
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

const select = () => screen.getByLabelText('Time zone') as HTMLSelectElement

describe('TimezoneCard', () => {
  it('shows the stored zone as the selected option', () => {
    render(<TimezoneCard current="America/Chicago" />)
    expect(select().value).toBe('America/Chicago')
  })

  // A zone the browser does not enumerate must still be visible rather than silently replaced by
  // whatever happens to sort first.
  it('keeps an unrecognised stored zone in the list', () => {
    render(<TimezoneCard current="Etc/GMT+3" />)
    expect(Array.from(select().options).some((o) => o.value === 'Etc/GMT+3')).toBe(true)
    expect(select().value).toBe('Etc/GMT+3')
  })

  it('offers a real list of zones', () => {
    render(<TimezoneCard current="America/New_York" />)
    expect(select().options.length).toBeGreaterThan(5)
    expect(Array.from(select().options).some((o) => o.value === 'America/New_York')).toBe(true)
  })
})

// #165: the card checked res.ok alone, so a change made after the session ended, which is redirected
// to the login page and answers 200, read as saved. The zone decides the month every page shows.
describe('TimezoneCard saves', () => {
  const choose = (zone = 'America/Chicago') => fireEvent.change(select(), { target: { value: zone } })

  it('saves the zone chosen, keeps showing it and reloads', async () => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)
    render(<TimezoneCard current="America/New_York" />)
    choose()
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/household/timezone')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ timezone: 'America/Chicago' })
    expect(select().value).toBe('America/Chicago')
    expect(select().disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // Nothing was written: say why, and put the stored zone back so the select never shows a zone
  // that is not in force.
  it.each([
    ['a refusal', () => refused(400, 'That is not a timezone we recognise.'), 'That is not a timezone we recognise.'],
    ['a redirect to the login page', redirectedToLogin, 'Your session ended. Sign in again.'],
    ['a 200 without ok: true', () => new Response('{}', { headers: { 'content-type': 'application/json' } }), 'That could not be saved.'],
  ])('after %s, says why under the select and shows the stored zone', async (_, reply, message) => {
    vi.stubGlobal('fetch', answering(reply))
    render(<TimezoneCard current="America/New_York" />)
    choose()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(message)
    expect(select().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(select().value).toBe('America/New_York')
    expect(select().disabled).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })

  // It may have saved: show the stored zone as last read, and reload to show which it is.
  it.each([
    ['a gateway error page', () => answering(badGateway)],
    ['a request that fails in flight', () => offline()],
  ])('after %s, says it may not have saved, shows the stored zone and reloads', async (_, fetchMock) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    render(<TimezoneCard current="America/New_York" />)
    choose()
    expect((await screen.findByRole('alert')).textContent).toBe('It may not have saved. Showing the latest.')
    expect(select().value).toBe('America/New_York')
    expect(select().disabled).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith('[TimezoneCard] save failed', expect.anything())
  })

  it('gives up on a request that never settles: says so, shows the stored zone, reloads and re-enables', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    render(<TimezoneCard current="America/New_York" />)
    choose()
    // The choice shows while it is being saved, and the select waits for it.
    expect(select().value).toBe('America/Chicago')
    expect(select().disabled).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    })
    expect(screen.getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
    expect(select().value).toBe('America/New_York')
    expect(select().disabled).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  // Whether or not it landed, the reload is the latest.
  it.each([
    ['it did not land', 'America/New_York'],
    ['it landed', 'America/Chicago'],
  ])('after an unknown outcome, the reload shows the latest when %s', async (_, latest) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', answering(badGateway))
    const { rerender } = render(<TimezoneCard current="America/New_York" />)
    choose()
    await screen.findByRole('alert')
    rerender(<TimezoneCard current={latest} />)
    expect(select().value).toBe(latest)
  })

  it('shows a zone set on the other phone once a reload brings it', () => {
    const { rerender } = render(<TimezoneCard current="America/New_York" />)
    rerender(<TimezoneCard current="America/Denver" />)
    expect(select().value).toBe('America/Denver')
  })

  // The zone just saved shows until the reload brings it. After that the select is the server's
  // again: kept, the saved zone would hide one the other phone sets later.
  it('follows the server again once the reload after a save arrives', async () => {
    vi.stubGlobal('fetch', answering(saved))
    const { rerender } = render(<TimezoneCard current="America/New_York" />)
    choose()
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    rerender(<TimezoneCard current="America/Chicago" />)
    expect(select().value).toBe('America/Chicago')
    rerender(<TimezoneCard current="America/Denver" />)
    expect(select().value).toBe('America/Denver')
  })

  // The reload after one change can land while the next is saving. Clearing the choice then showed
  // the earlier zone while the next one saved, and went on showing it once it had saved.
  it('keeps showing the zone being saved when the reload after an earlier change lands mid-save', async () => {
    let settle!: (res: Response) => void
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(saved())
        .mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve)))
    )
    const { rerender } = render(<TimezoneCard current="America/New_York" />)
    choose('America/Chicago')
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    choose('America/Denver')
    rerender(<TimezoneCard current="America/Chicago" />)
    expect(select().value).toBe('America/Denver')
    settle(saved())
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
    expect(select().value).toBe('America/Denver')
    rerender(<TimezoneCard current="America/Denver" />)
    expect(select().value).toBe('America/Denver')
  })

  it('clears an earlier error once the next change saves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(refused(500, 'That could not be saved. Please try again.')).mockResolvedValueOnce(saved())
    )
    render(<TimezoneCard current="America/New_York" />)
    choose()
    await screen.findByRole('alert')
    choose('America/Denver')
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(select().value).toBe('America/Denver')
  })
})
