import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { isInviteOnlyRejection } from '@/lib/authError'
import AuthCodeError from '@/app/auth/auth-code-error/page'

// Auto-cleanup only registers when vitest runs with globals; this suite does not.
afterEach(() => {
  cleanup()
  window.location.hash = ''
})

// The regression this guards: Supabase reports "signups disabled" in the URL FRAGMENT
// (#error_code=signup_disabled), which only the browser can see. Uninvited visitors were
// shown "The login link was invalid or expired" — misleading, since nothing expired and
// requesting a new link can never help them. They should be told the app is invite-only.
describe('isInviteOnlyRejection', () => {
  it('recognises the signup_disabled fragment Supabase sends for uninvited accounts', () => {
    expect(
      isInviteOnlyRejection(
        '#error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed+for+this+instance&sb='
      )
    ).toBe(true)
  })

  it('is false for an empty fragment (server-side failures keep the expired-link copy)', () => {
    expect(isInviteOnlyRejection('')).toBe(false)
  })

  it('is false for other error codes, e.g. a genuinely expired link', () => {
    expect(isInviteOnlyRejection('#error=access_denied&error_code=otp_expired')).toBe(false)
  })
})

describe('AuthCodeError page', () => {
  it('explains invite-only access when the fragment says signup_disabled', async () => {
    window.location.hash =
      '#error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed+for+this+instance&sb='
    render(<AuthCodeError />)
    expect(await screen.findByText(/invite-only/i)).toBeTruthy()
    expect(screen.queryByText(/invalid or expired/i)).toBeNull()
  })

  it('keeps the expired-link copy when there is no error fragment', () => {
    render(<AuthCodeError />)
    expect(screen.getByText(/invalid or expired/i)).toBeTruthy()
    expect(screen.queryByText(/invite-only/i)).toBeNull()
  })
})
