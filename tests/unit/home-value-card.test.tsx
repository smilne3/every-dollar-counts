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

const props = { initialValue: 700000, updatedAt: '2026-10-01T12:00:00Z' }

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
})
