import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { isInviteOnlyRejection } from '@/lib/authError'
import AuthCodeError from '@/app/auth/auth-code-error/page'
import SignInTryAgain from '@/app/auth/try-again/page'

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

  // #149: someone in the household who signed in with their other Google account lands here. The
  // page had no way back to sign in, and the installed app has no address bar to get there.
  it('offers a way back to sign in, where Google asks which account, when the fragment says signup_disabled', async () => {
    window.location.hash =
      '#error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed+for+this+instance&sb='
    render(<AuthCodeError />)
    const back = await screen.findByRole('link', { name: 'Sign in with a different account' })
    expect(back.getAttribute('href')).toBe('/login')
  })

  it('keeps the expired-link copy when there is no error fragment', () => {
    render(<AuthCodeError />)
    expect(screen.getByText(/invalid or expired/i)).toBeTruthy()
    expect(screen.queryByText(/invite-only/i)).toBeNull()
  })
})

// #143: where app/auth/confirm/route.ts sends someone it could not finish signing in because
// Supabase Auth could not be asked. Nothing showed they aren't invited, or that the link was bad.
describe('SignInTryAgain page', () => {
  it('says sign-in could not be completed and to try again, with the way back to sign in', () => {
    render(<SignInTryAgain />)
    expect(screen.getByRole('heading').textContent).toBe("Sign-in couldn't be completed")
    expect(screen.getByText(/^Something went wrong/).textContent).toBe(
      'Something went wrong reaching the sign-in service. Try again, or come back in a moment.'
    )
    expect(screen.getByRole('link', { name: 'Back to sign in' }).getAttribute('href')).toBe('/login')
  })

  it('says nothing about invites or the link', () => {
    render(<SignInTryAgain />)
    expect(screen.queryByText(/invite/i)).toBeNull()
    expect(screen.queryByText(/expired|invalid/i)).toBeNull()
  })
})
