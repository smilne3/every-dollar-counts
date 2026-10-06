import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import LoginPage from '@/app/login/page'
import { LinkButton } from '@/components/LinkButton'
import { ReconnectButton } from '@/components/ReconnectButton'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

// An installed iOS app keeps its own cookies and storage, apart from the browser's (#21). Anything
// that leaves the app and expects to come back to the same storage breaks inside it:
// - a magic link opens in the browser, so the session lands where the app cannot see it;
// - Plaid's bank login stores the pending link in localStorage, so a return that lands in the
//   browser strands a connection whose lifetime slot is already spent.

// jsdom has no matchMedia. Each case installs one, and `navigator.standalone` (iOS's own flag)
// separately, because either one alone must count.
function setStandalone({ media = false, ios = false }: { media?: boolean; ios?: boolean }) {
  window.matchMedia = ((query: string) => ({
    matches: media && query === '(display-mode: standalone)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
  Object.defineProperty(window.navigator, 'standalone', { value: ios, configurable: true })
}

afterEach(() => {
  cleanup()
  setStandalone({})
})

describe.each([
  ['display-mode: standalone', { media: true }],
  ['navigator.standalone (iOS)', { ios: true }],
])('installed app, detected by %s', (_, mode) => {
  it('login offers Google only, and says why there is no email link', () => {
    setStandalone(mode)
    render(<LoginPage />)
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeTruthy()
    expect(screen.queryByPlaceholderText('you@email.com')).toBeNull()
    expect(screen.queryByRole('button', { name: /email me a login link/i })).toBeNull()
    expect(screen.getByText(/email links open in your browser/i)).toBeTruthy()
  })

  it('bank connection buttons are disabled, with a pointer to the browser', () => {
    setStandalone(mode)
    render(<LinkButton />)
    expect(screen.getByRole('button', { name: /connect a bank/i }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: /add investment account/i }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/connect banks from your browser/i)).toBeTruthy()
  })

  it('reconnect is disabled, with a pointer to the browser', () => {
    setStandalone(mode)
    render(<ReconnectButton itemId="item-1" />)
    expect(screen.getByRole('button', { name: /reconnect/i }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/from your browser/i)).toBeTruthy()
  })
})

describe('in a browser tab', () => {
  it('login keeps the email link', () => {
    setStandalone({})
    render(<LoginPage />)
    expect(screen.getByPlaceholderText('you@email.com')).toBeTruthy()
    expect(screen.queryByText(/email links open in your browser/i)).toBeNull()
  })

  it('bank buttons are enabled and say nothing about the browser', () => {
    setStandalone({})
    render(<LinkButton />)
    expect(screen.getByRole('button', { name: /connect a bank/i }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText(/from your browser/i)).toBeNull()
    cleanup()
    render(<ReconnectButton itemId="item-1" />)
    expect(screen.getByRole('button', { name: /reconnect/i }).hasAttribute('disabled')).toBe(false)
  })
})
