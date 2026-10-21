import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { HomeValueCard } from '@/components/HomeValueCard'
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

// readAt is when the page read the value, by the server's clock.
const props = { initialValue: 700000, updatedAt: '2026-10-01T12:00:00Z', readAt: 1_000 }

// #165: the card checked res.ok alone, so a save made after the session ended, which is redirected
// to the login page and answers 200, read as saved. The home value moves net worth.
describe('HomeValueCard saves', () => {
  const field = () => screen.getByLabelText('Home value') as HTMLInputElement
  const button = () => screen.getByRole('button', { name: /^(Save|Saving…)$/ }) as HTMLButtonElement
  function typeAndSave(value = '$750,000') {
    fireEvent.change(field(), { target: { value } })
    fireEvent.click(button())
  }

  it('sends what Zillow shows as a number, then reloads', async () => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)
    render(<HomeValueCard {...props} />)
    typeAndSave()
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/manual-assets')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ value: 750000 })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button().textContent).toBe('Save')
    expect(button().disabled).toBe(false)
  })

  // Nothing was written: say why under the button, keep what was typed for another try, and do not
  // reload.
  it.each([
    [
      'a refusal',
      () => refused(409, 'This app is pointed at a database from a different environment. Nothing saved.'),
      'This app is pointed at a database from a different environment. Nothing saved.',
    ],
    ['a redirect to the login page', redirectedToLogin, 'Your session ended. Sign in again.'],
    ['a 200 without ok: true', () => new Response('{}', { headers: { 'content-type': 'application/json' } }), 'That could not be saved.'],
  ])('after %s, says why under the button and keeps what was typed', async (_, reply, message) => {
    vi.stubGlobal('fetch', answering(reply))
    render(<HomeValueCard {...props} />)
    typeAndSave()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(message)
    expect(button().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(field().value).toBe('$750,000')
    expect(refresh).not.toHaveBeenCalled()
    expect(button().disabled).toBe(false)
    expect(field().disabled).toBe(false)
  })

  // It may have saved. Saving again is safe, since a save sets the value, so what was typed stays;
  // the reload's "Currently" line shows what is stored.
  it.each([
    ['a gateway error page', () => answering(badGateway)],
    ['a request that fails in flight', () => offline()],
    // The route's own answer when the database never answered its write (#173).
    ["the route's word that the database never answered", () => answering(unanswered)],
  ])('after %s, says it may not have saved, keeps what was typed and reloads', async (_, fetchMock) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    render(<HomeValueCard {...props} />)
    typeAndSave()
    expect((await screen.findByRole('alert')).textContent).toBe('It may not have saved. Showing the latest.')
    expect(field().value).toBe('$750,000')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(button().disabled).toBe(false)
    expect(logged).toHaveBeenCalledWith('[HomeValueCard] save failed', expect.anything())
  })

  it('gives up on a request that never settles: says so, reloads and re-enables', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    render(<HomeValueCard {...props} />)
    typeAndSave()
    expect(button().textContent).toBe('Saving…')
    expect(button().disabled).toBe(true)
    expect(field().disabled).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    })
    expect(screen.getByRole('alert').textContent).toBe('It may not have saved. Showing the latest.')
    expect(button().textContent).toBe('Save')
    expect(button().disabled).toBe(false)
    expect(field().disabled).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  // A blank field used to go out as 0 (Number('') is 0) and set the home to $0: net worth fell by
  // the whole house, and the fresh updated_at turned off the reminder to update it.
  it.each([
    ['a value it cannot read', 'about 750k'],
    ['a negative value', '-$5,000'],
    ['an empty field', ''],
    ['a field of spaces', '   '],
    ['a field with only a dollar sign', '$'],
  ])('refuses %s, and sends nothing', (_, typed) => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)
    render(<HomeValueCard {...props} />)
    typeAndSave(typed)
    expect(screen.getByRole('alert').textContent).toBe('Enter your home value, e.g. 750000 or $750,000.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still saves a home value of zero, typed as 0', async () => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)
    render(<HomeValueCard {...props} />)
    typeAndSave('0')
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ value: 0 })
  })

  it('clears an earlier error once a save succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(refused(500, 'That could not be saved. Please try again.')).mockResolvedValueOnce(saved())
    )
    render(<HomeValueCard {...props} />)
    typeAndSave()
    await screen.findByRole('alert')
    fireEvent.click(button())
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // Save is disabled while a save is in flight; Enter in the field submits the form without it.
  it('ignores Enter in the field while a save is in flight', () => {
    const fetchMock = neverSettles()
    vi.stubGlobal('fetch', fetchMock)
    render(<HomeValueCard {...props} />)
    typeAndSave()
    fireEvent.submit(field().closest('form') as HTMLFormElement)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // #174: the field was filled once and never followed the server. With Settings open, a value saved
  // on the other phone reached "Currently" with the next reload but not the field, and a Save without
  // retyping sent the old value over the new one, moving net worth back with nothing to say so.
  // Times are the server's clock: the route says when it wrote (savedAt), and the page when it read
  // (readAt). The home starts at 700,000, read at 1,000.
  describe('and the server (#174)', () => {
    const TRY_AGAIN = 'That could not be saved. Please try again.'
    // The "Currently" line, which says what is stored.
    const currently = () => screen.getByText(/^Currently /).textContent
    // A reload of the page: the value it read, and when.
    const reloaded = (initialValue: number, readAt: number) => (
      <HomeValueCard initialValue={initialValue} updatedAt="2026-10-20T12:00:00Z" readAt={readAt} />
    )
    // A save, and the render after it settles: the field and Save are disabled until then.
    async function saveAndSettle(value: string) {
      typeAndSave(value)
      await waitFor(() => expect(button().disabled).toBe(false))
    }
    // A first save that lands, written at 2,000, then a second whose reply waits for the test.
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

    it('follows a value saved on the other phone, so a Save without retyping sends it, not the old one', async () => {
      const fetchMock = answering(() => savedAt(3_000))
      vi.stubGlobal('fetch', fetchMock)
      const { rerender } = render(<HomeValueCard {...props} />)
      // Read at 2,000: the other phone has saved 800,000.
      rerender(reloaded(800000, 2_000))
      expect(field().value).toBe('800000')
      fireEvent.click(button())
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ value: 800000 })
    })

    it('keeps what is being typed when a reload brings another value', () => {
      const { rerender } = render(<HomeValueCard {...props} />)
      fireEvent.change(field(), { target: { value: '$750,000' } })
      rerender(reloaded(800000, 2_000))
      expect(field().value).toBe('$750,000')
      expect(currently()).toContain('$800,000.00')
    })

    // As Zillow shows it: a reload that brings back the value saved leaves the field as it was typed.
    it('keeps the value as it was typed once the reload after its save brings it back', async () => {
      vi.stubGlobal('fetch', answering(() => savedAt(2_000)))
      const { rerender } = render(<HomeValueCard {...props} />)
      await saveAndSettle('$750,000')
      rerender(reloaded(750000, 2_500))
      expect(field().value).toBe('$750,000')
    })

    // Reloads are told apart by when they read, not by the value they bring: the other phone saved
    // 700,000 again after this one saved 750,000, and the reload that brings it must still refill the
    // field, or the next Save sends 750,000 back over it.
    it('follows a reload that brings back the value it was filled with before the save', async () => {
      vi.stubGlobal('fetch', answering(() => savedAt(2_000)))
      const { rerender } = render(<HomeValueCard {...props} />)
      await saveAndSettle('750000')
      rerender(reloaded(700000, 2_500))
      expect(field().value).toBe('700000')
      expect(currently()).toContain('$700,000.00')
    })

    // "Currently" says what is stored after each outcome. Once a save is confirmed, that is the value
    // it wrote, until a reload that read after it says otherwise.
    it('says the value saved is the current one once the save is confirmed', async () => {
      vi.stubGlobal('fetch', answering(() => savedAt(2_000)))
      render(<HomeValueCard {...props} />)
      await saveAndSettle('750000')
      expect(currently()).toContain('$750,000.00')
    })

    // #182's race, here: two quick saves, and the reload asked for after the first read the value
    // before the second was written. Shown, it said the first save's value was current beside the
    // second's in the field, as if the second had not saved.
    it("keeps the second save's value, and says it is current, when the first save's reload lands after it", async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)).mockResolvedValueOnce(savedAt(3_000)))
      const { rerender } = render(<HomeValueCard {...props} />)
      await saveAndSettle('750000')
      await saveAndSettle('800000')
      // The first save's reload, read at 2,500: after it was written and before the second was.
      rerender(reloaded(750000, 2_500))
      expect(field().value).toBe('800000')
      expect(currently()).toContain('$800,000.00')
      rerender(reloaded(800000, 3_500))
      expect(field().value).toBe('800000')
      expect(currently()).toContain('$800,000.00')
    })

    // The page takes its time before reading and the route after writing, so a read stamped in the
    // same millisecond as the write may still have read before it. The next reload brings anything
    // newer, a value saved on the other phone with it.
    it('does not follow a read stamped at the time of the save, and does one after it', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)))
      const { rerender } = render(<HomeValueCard {...props} />)
      await saveAndSettle('750000')
      rerender(reloaded(700000, 2_000))
      expect(field().value).toBe('750000')
      expect(currently()).toContain('$750,000.00')
      rerender(reloaded(800000, 2_001))
      expect(field().value).toBe('800000')
      expect(currently()).toContain('$800,000.00')
    })

    // In Next 16.4.2 the first save's reload can land while the second is in flight (see #176), and
    // the field then holds what the second sent. Refilled from it, the field showed 750,000 once
    // 800,000 had saved, and the next Save sent 750,000 back over it.
    it("keeps the second save's value when the first save's reload lands while it is in flight", async () => {
      const settle = firstSavedThenHeld()
      const { rerender } = render(<HomeValueCard {...props} />)
      await saveAndSettle('750000')
      typeAndSave('800000')
      rerender(reloaded(750000, 2_500))
      expect(field().value).toBe('800000')
      settle(savedAt(3_000))
      await waitFor(() => expect(button().disabled).toBe(false))
      expect(field().value).toBe('800000')
      expect(currently()).toContain('$800,000.00')
    })

    // Nothing reloads after a refusal, so the first save's reload can still land after it. What was
    // typed for the refused save was not stored: it is typing, which no reload overwrites.
    it("keeps what was typed after a refusal when the first save's reload lands after it", async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(savedAt(2_000)).mockResolvedValueOnce(refused(500, TRY_AGAIN)))
      const { rerender } = render(<HomeValueCard {...props} />)
      await saveAndSettle('750000')
      typeAndSave('800000')
      await screen.findByRole('alert')
      rerender(reloaded(750000, 2_500))
      expect(field().value).toBe('800000')
      expect(currently()).toContain('$750,000.00')
    })

    // It may have saved, and what was typed stays (#177): saving again sets the same value. Whatever
    // the reload after it brings, the field keeps it, and "Currently" says what is stored.
    it('keeps what was typed after an unknown outcome, whatever the reload brings', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('fetch', answering(badGateway))
      const { rerender } = render(<HomeValueCard {...props} />)
      typeAndSave('$750,000')
      await screen.findByRole('alert')
      // The reload after it, read at 2,000: the save did not land.
      rerender(reloaded(700000, 2_000))
      expect(field().value).toBe('$750,000')
      expect(currently()).toContain('$700,000.00')
    })

    // It may have saved, and the reload after it shows it did: the field then holds what the server
    // has, so nothing typed is at stake, and it follows the server again. Left as typing, it kept
    // 750,000 beside the other phone's 800,000, and a Save without retyping sent 750,000 back over it,
    // which is #174 again.
    it('follows the server again once a reload shows that a save with an unknown outcome landed', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const fetchMock = vi.fn().mockResolvedValueOnce(badGateway()).mockResolvedValueOnce(savedAt(9_000))
      vi.stubGlobal('fetch', fetchMock)
      const { rerender } = render(<HomeValueCard {...props} />)
      typeAndSave('$750,000')
      await screen.findByRole('alert')
      // The reload after it, read at 2,000: the save landed.
      rerender(reloaded(750000, 2_000))
      expect(field().value).toBe('$750,000')
      // Read at 5,000: the other phone has saved 800,000 since.
      rerender(reloaded(800000, 5_000))
      expect(field().value).toBe('800000')
      fireEvent.click(button())
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({ value: 800000 })
    })

    // Only a read made after the last save confirmed here says what the server has now. An older one
    // that happens to hold what is being typed is not taken as the server having it: taken so, the
    // typing counted as filled, and the next reload overwrote it.
    it('does not take a read made before the last save as the server holding what is typed', async () => {
      vi.stubGlobal('fetch', answering(() => savedAt(2_000)))
      const { rerender } = render(<HomeValueCard {...props} />)
      await saveAndSettle('750000')
      fireEvent.change(field(), { target: { value: '700000' } })
      // Read at 1,500, before the save was written.
      rerender(reloaded(700000, 1_500))
      // Read at 2,500, after it.
      rerender(reloaded(750000, 2_500))
      expect(field().value).toBe('700000')
    })

    // Saved without retyping, the field holds what it was filled with, and a reload that lands while
    // that save is in flight is held back. Nothing reloads after a refusal, so it is applied once the
    // save is refused: left unapplied, the field kept 700,000 beside the other phone's 800,000, for
    // the next Save to send back over it.
    it('applies a reload that landed during a refused save once it is refused', async () => {
      let settle!: (res: Response) => void
      vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve))))
      const { rerender } = render(<HomeValueCard {...props} />)
      fireEvent.click(button())
      // Read at 1,500: the other phone has saved 800,000.
      rerender(reloaded(800000, 1_500))
      expect(field().value).toBe('700000')
      settle(refused(500, TRY_AGAIN))
      await screen.findByRole('alert')
      expect(field().value).toBe('800000')
    })
  })
})
