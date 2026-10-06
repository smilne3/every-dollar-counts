// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { config } from '@/proxy'

// The regression this guards (#21): the proxy redirects any request without a session to /login,
// and production browsers fetch the web app manifest WITHOUT credentials. If the matcher covers
// the manifest or the home-screen icons, "Add to Home Screen" gets a 307 to the login page instead
// of a manifest, and installing fails even for someone who is signed in.
//
// `config` is imported, not copied, so this tests the matcher that actually ships.
// (The docs name `unstable_doesProxyMatch`; 16.3.5 only exports the middleware-named one.)
const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url })

describe('proxy matcher and the installable-app assets', () => {
  it.each([
    '/manifest.webmanifest',
    '/icon.png',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-maskable-512.png',
    '/apple-icon.png',
    '/apple-touch-icon.png',
  ])('does not run the login gate for %s', (url) => {
    expect(matches(url)).toBe(false)
  })

  it.each(['/dashboard', '/login', '/settings', '/api/plaid/sync-transactions', '/api/x/icon.png'])(
    'still runs for %s',
    (url) => {
      expect(matches(url)).toBe(true)
    }
  )

  // The exemption names files; it must not become "every .png anywhere".
  it('still runs for a png that is not one of the app icons', () => {
    expect(matches('/screenshot.png')).toBe(true)
  })
})
