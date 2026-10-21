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
  savedAt,
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
    render(<TimezoneCard current="America/Chicago" readAt={1_000} />)
    expect(select().value).toBe('America/Chicago')
  })

  // A zone the browser does not enumerate must still be visible rather than silently replaced by
  // whatever happens to sort first.
  it('keeps an unrecognised stored zone in the list', () => {
    render(<TimezoneCard current="Etc/GMT+3" readAt={1_000} />)
    expect(Array.from(select().options).some((o) => o.value === 'Etc/GMT+3')).toBe(true)
    expect(select().value).toBe('Etc/GMT+3')
  })

  it('offers a real list of zones', () => {
    render(<TimezoneCard current="America/New_York" readAt={1_000} />)
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
    render(<TimezoneCard current="America/New_York" readAt={1_000} />)
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
    render(<TimezoneCard current="America/New_York" readAt={1_000} />)
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
    render(<TimezoneCard current="America/New_York" readAt={1_000} />)
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
    render(<TimezoneCard current="America/New_York" readAt={1_000} />)
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
    const { rerender } = render(<TimezoneCard current="America/New_York" readAt={1_000} />)
    choose()
    await screen.findByRole('alert')
    rerender(<TimezoneCard current={latest} readAt={2_000} />)
    expect(select().value).toBe(latest)
  })

  it('shows a zone set on the other phone once a reload brings it', () => {
    const { rerender } = render(<TimezoneCard current="America/New_York" readAt={1_000} />)
    rerender(<TimezoneCard current="America/Denver" readAt={2_000} />)
    expect(select().value).toBe('America/Denver')
  })

  // The zone just saved shows until the reload brings it. After that the select is the server's
  // again: kept, the saved zone would hide one the other phone sets later.
  it('follows the server again once the reload after a save arrives', async () => {
    vi.stubGlobal('fetch', answering(saved))
    const { rerender } = render(<TimezoneCard current="America/New_York" readAt={1_000} />)
    choose()
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    rerender(<TimezoneCard current="America/Chicago" readAt={2_000} />)
    expect(select().value).toBe('America/Chicago')
    rerender(<TimezoneCard current="America/Denver" readAt={3_000} />)
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
    const { rerender } = render(<TimezoneCard current="America/New_York" readAt={1_000} />)
    choose('America/Chicago')
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    choose('America/Denver')
    rerender(<TimezoneCard current="America/Chicago" readAt={2_000} />)
    expect(select().value).toBe('America/Denver')
    settle(saved())
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
    expect(select().value).toBe('America/Denver')
    rerender(<TimezoneCard current="America/Denver" readAt={3_000} />)
    expect(select().value).toBe('America/Denver')
  })

  it('clears an earlier error once the next change saves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(refused(500, 'That could not be saved. Please try again.')).mockResolvedValueOnce(saved())
    )
    render(<TimezoneCard current="America/New_York" readAt={1_000} />)
    choose()
    await screen.findByRole('alert')
    choose('America/Denver')
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(select().value).toBe('America/Denver')
  })

  // #182: two quick changes, and the reload asked for after the first read the zone before the
  // second was written. Followed, it put the first zone back in the select once the second had
  // saved, until the next reload. Times are the server's clock: the route says when it wrote
  // (savedAt), and the page when it read (readAt). The zone starts as New York, read at 1,000.
  describe('and a reload that read before the last save (#182)', () => {
    const TRY_AGAIN = 'That could not be saved. Please try again.'
    // A change, and the render after it settles: the select is disabled until then.
    async function chooseAndSettle(zone: string) {
      choose(zone)
      await waitFor(() => expect(select().disabled).toBe(false))
    }
    // A first change that lands, written at 2,000, then a second whose reply waits for the test.
    function firstSavedThenHeld() {
      let settle!: (res: Response) => void
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(savedAt(2_000))
          .mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve)))
      )
      return (res: Response) => settle(res)
    }

    it("keeps showing the second zone saved when the first change's reload lands after it", async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)).mockResolvedValueOnce(savedAt(3_000)))
      const { rerender } = render(<TimezoneCard current="America/New_York" readAt={1_000} />)
      await chooseAndSettle('America/Chicago')
      await chooseAndSettle('America/Denver')
      // The first change's reload, read at 2,500: after Chicago was written and before Denver was.
      rerender(<TimezoneCard current="America/Chicago" readAt={2_500} />)
      expect(select().value).toBe('America/Denver')
      rerender(<TimezoneCard current="America/Denver" readAt={3_500} />)
      expect(select().value).toBe('America/Denver')
    })

    // The page takes its time before reading and the route after writing, so a read stamped in the
    // same millisecond as the write may still have read before it. The next reload brings anything
    // newer, a zone set on the other phone with it.
    it('does not follow a read stamped at the time of the save, and does one after it', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)))
      const { rerender } = render(<TimezoneCard current="America/New_York" readAt={1_000} />)
      await chooseAndSettle('America/Chicago')
      rerender(<TimezoneCard current="America/New_York" readAt={2_000} />)
      expect(select().value).toBe('America/Chicago')
      rerender(<TimezoneCard current="America/Denver" readAt={2_001} />)
      expect(select().value).toBe('America/Denver')
    })

    // Reloads are told apart by when they read, not by the zone they bring. Told apart by zone, a
    // reload bringing New York, set again on the other phone after Chicago was saved, was not
    // followed: it is the zone the select showed before, so the select went on showing Chicago.
    it('follows a reload that brings back the zone shown before the save', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)))
      const { rerender } = render(<TimezoneCard current="America/New_York" readAt={1_000} />)
      await chooseAndSettle('America/Chicago')
      rerender(<TimezoneCard current="America/New_York" readAt={2_500} />)
      expect(select().value).toBe('America/New_York')
    })

    // Nothing was written, and the first change's reload may not have landed yet. Back to the zone as
    // last read, the select showed New York, from before Chicago was saved.
    it('after a refused change, shows the zone saved before it, not an older one', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)).mockResolvedValueOnce(refused(500, TRY_AGAIN)))
      const { rerender } = render(<TimezoneCard current="America/New_York" readAt={1_000} />)
      await chooseAndSettle('America/Chicago')
      choose('America/Denver')
      await screen.findByRole('alert')
      expect(select().value).toBe('America/Chicago')
      // The first change's reload, read at 2,500, lands after it.
      rerender(<TimezoneCard current="America/Chicago" readAt={2_500} />)
      expect(select().value).toBe('America/Chicago')
    })

    // It may have saved, and the reload after it shows which. Until it lands, the zone saved before is
    // the newest known to be stored.
    it('after a change whose outcome is unknown, shows the zone saved before it until the reload', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)).mockResolvedValueOnce(badGateway()))
      const { rerender } = render(<TimezoneCard current="America/New_York" readAt={1_000} />)
      await chooseAndSettle('America/Chicago')
      choose('America/Denver')
      expect((await screen.findByRole('alert')).textContent).toBe('It may not have saved. Showing the latest.')
      expect(select().value).toBe('America/Chicago')
      // The reload after it: Denver landed.
      rerender(<TimezoneCard current="America/Denver" readAt={3_500} />)
      expect(select().value).toBe('America/Denver')
    })

    // A reload that lands while a change is saving is held back, and nothing reloads after a refusal.
    // Applied once it is refused, it brings the zone the other phone set after Chicago was saved; left
    // unapplied, the select went on showing Chicago.
    it('applies a reload that landed during a refused change once it is refused', async () => {
      const settle = firstSavedThenHeld()
      const { rerender } = render(<TimezoneCard current="America/New_York" readAt={1_000} />)
      await chooseAndSettle('America/Chicago')
      choose('America/Denver')
      // The first change's reload, read at 2,500: the other phone has set Phoenix since.
      rerender(<TimezoneCard current="America/Phoenix" readAt={2_500} />)
      expect(select().value).toBe('America/Denver')
      settle(refused(500, TRY_AGAIN))
      await screen.findByRole('alert')
      expect(select().value).toBe('America/Phoenix')
    })

    // The same after an unknown outcome, until the reload after it lands: the page read after Chicago
    // was saved is newer than the zone saved before, which would have shown in its place.
    it('applies a reload that landed during a change whose outcome is unknown', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const settle = firstSavedThenHeld()
      const { rerender } = render(<TimezoneCard current="America/New_York" readAt={1_000} />)
      await chooseAndSettle('America/Chicago')
      choose('America/Denver')
      rerender(<TimezoneCard current="America/Phoenix" readAt={2_500} />)
      settle(badGateway())
      await screen.findByRole('alert')
      expect(select().value).toBe('America/Phoenix')
    })

    // Applied again after a refusal, the page is still only as new as its read: one made before the
    // last confirmed save does not replace the zone it saved.
    it('does not apply a reload older than the last save once a later change is refused', async () => {
      const settle = firstSavedThenHeld()
      const { rerender } = render(<TimezoneCard current="America/New_York" readAt={1_000} />)
      await chooseAndSettle('America/Chicago')
      choose('America/Denver')
      // Read at 1,500, before Chicago was written.
      rerender(<TimezoneCard current="America/New_York" readAt={1_500} />)
      settle(refused(500, TRY_AGAIN))
      await screen.findByRole('alert')
      expect(select().value).toBe('America/Chicago')
    })
  })
})
