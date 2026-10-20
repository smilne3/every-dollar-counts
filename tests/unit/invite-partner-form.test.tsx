import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { InvitePartnerForm } from '@/components/InvitePartnerForm'
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
})

const SIGN_IN = 'partner@example.com can now sign in (with Google or an email link) and will join your household.'

// #165: the form checked res.ok alone, so an invite sent after the session ended, which is
// redirected to the login page and answers 200, said "… can now sign in" for an invite never
// written. A request that threw left the button on "Sending…" for good.
describe('InvitePartnerForm saves', () => {
  const field = () => screen.getByLabelText("Partner's email address") as HTMLInputElement
  const button = () => screen.getByRole('button', { name: /^(Invite|Sending…)$/ }) as HTMLButtonElement
  function invite() {
    fireEvent.change(field(), { target: { value: 'partner@example.com' } })
    fireEvent.click(button())
  }

  it('invites the address to the household, says they can now sign in, and clears the field', async () => {
    const fetchMock = answering(saved)
    vi.stubGlobal('fetch', fetchMock)
    render(<InvitePartnerForm householdId="hh-1" />)
    invite()
    const done = await screen.findByText(SIGN_IN)
    expect(done.getAttribute('role')).toBeNull()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/household/invite')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ email: 'partner@example.com', household_id: 'hh-1' })
    expect(field().value).toBe('')
    expect(button().textContent).toBe('Invite')
    expect(button().disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // Nothing was written: say why, and keep the address for another try.
  it.each([
    ['a refusal', () => refused(403, "Your account isn't part of this household."), "Your account isn't part of this household."],
    ['a redirect to the login page', redirectedToLogin, 'Your session ended. Sign in again.'],
    ['a 200 without ok: true', () => new Response('{}', { headers: { 'content-type': 'application/json' } }), 'That could not be saved.'],
  ])('after %s, says why under the field and keeps the address', async (_, reply, message) => {
    vi.stubGlobal('fetch', answering(reply))
    render(<InvitePartnerForm householdId="hh-1" />)
    invite()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(message)
    expect(field().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText(/can now sign in/)).toBeNull()
    expect(field().value).toBe('partner@example.com')
    expect(button().disabled).toBe(false)
    expect(field().disabled).toBe(false)
  })

  // It may have been written. Nothing on the page lists invites, so there is nothing to reload, and
  // inviting again is safe: the allowlist is keyed on the email.
  it.each([
    ['a gateway error page', () => answering(badGateway)],
    ['a request that fails in flight', () => offline()],
  ])('after %s, says it may not have saved, keeps the address and asks for another try', async (_, fetchMock) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock())
    render(<InvitePartnerForm householdId="hh-1" />)
    invite()
    expect((await screen.findByRole('alert')).textContent).toBe('It may not have saved. Invite them again to be sure.')
    expect(screen.queryByText(/can now sign in/)).toBeNull()
    expect(field().value).toBe('partner@example.com')
    expect(button().disabled).toBe(false)
    expect(logged).toHaveBeenCalledWith('[InvitePartnerForm] save failed', expect.anything())
  })

  it('gives up on a request that never settles: says so and re-enables', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useFakeSaveClock()
    vi.stubGlobal('fetch', neverSettles())
    render(<InvitePartnerForm householdId="hh-1" />)
    invite()
    expect(button().textContent).toBe('Sending…')
    expect(button().disabled).toBe(true)
    expect(field().disabled).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    })
    expect(screen.getByRole('alert').textContent).toBe('It may not have saved. Invite them again to be sure.')
    expect(button().textContent).toBe('Invite')
    expect(button().disabled).toBe(false)
    expect(field().disabled).toBe(false)
  })

  // "… can now sign in" left beside the next invite's failure would claim that one worked too.
  it('clears an earlier success once the next invite starts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(saved()).mockResolvedValueOnce(refused(500, 'That could not be saved. Please try again.'))
    )
    render(<InvitePartnerForm householdId="hh-1" />)
    invite()
    await screen.findByText(SIGN_IN)
    invite()
    expect((await screen.findByRole('alert')).textContent).toBe('That could not be saved. Please try again.')
    expect(screen.queryByText(/can now sign in/)).toBeNull()
  })

  it('clears an earlier error once an invite saves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(refused(500, 'That could not be saved. Please try again.')).mockResolvedValueOnce(saved())
    )
    render(<InvitePartnerForm householdId="hh-1" />)
    invite()
    await screen.findByRole('alert')
    fireEvent.click(button())
    expect(await screen.findByText(SIGN_IN)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // Invite is disabled while an invite is in flight; Enter in the field submits the form without it.
  it('ignores Enter in the field while an invite is in flight', () => {
    const fetchMock = neverSettles()
    vi.stubGlobal('fetch', fetchMock)
    render(<InvitePartnerForm householdId="hh-1" />)
    invite()
    fireEvent.submit(field().closest('form') as HTMLFormElement)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
