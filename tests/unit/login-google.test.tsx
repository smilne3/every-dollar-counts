import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import LoginPage from '@/app/login/page'

// #149: left to choose, Google signed a phone with two accounts in with whichever it picked, and an
// account outside the household got the invite-only page on every try. Supabase passes queryParams
// on to Google's authorize URL, where prompt=select_account makes it ask.
const { signInWithOAuth } = vi.hoisted(() => ({ signInWithOAuth: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { signInWithOAuth } }) }))

// Auto-cleanup only registers when vitest runs with globals; this suite does not.
afterEach(() => {
  cleanup()
  signInWithOAuth.mockReset()
})

describe('LoginPage: Continue with Google', () => {
  it('asks Google which account to use', async () => {
    signInWithOAuth.mockResolvedValue({ error: null })
    render(<LoginPage />)
    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }))
    await waitFor(() => expect(signInWithOAuth).toHaveBeenCalledTimes(1))
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: `${location.origin}/auth/confirm`, queryParams: { prompt: 'select_account' } },
    })
  })
})
