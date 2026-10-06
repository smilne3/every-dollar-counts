import { describe, it, expect, vi } from 'vitest'

// next/font/google is a build-time transform; outside the Next compiler it has nothing to load.
vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: 'font-geist-sans' }),
  Geist_Mono: () => ({ variable: 'font-geist-mono' }),
}))

const { metadata, viewport } = await import('@/app/layout')
const { default: manifest } = await import('@/app/manifest')

describe('root layout metadata for the installable app (#21)', () => {
  // Without `cover`, env(safe-area-inset-*) is always 0, and the tab bar's
  // pb-[env(safe-area-inset-bottom)] does nothing: in standalone the tabs sit under the home
  // indicator.
  it('extends under the safe areas so the inset padding takes effect', () => {
    expect(viewport.viewportFit).toBe('cover')
  })

  it('gives the browser UI the same colour the manifest does', () => {
    expect(viewport.themeColor).toBe(manifest().theme_color)
  })

  // themeColor inside `metadata` is deprecated in this Next; it belongs to `viewport`.
  it('keeps themeColor out of metadata', () => {
    expect(metadata).not.toHaveProperty('themeColor')
  })

  // Any `metadata.icons` makes Next drop the app/icon.png and app/apple-icon.png file
  // conventions (node_modules/next/dist/lib/metadata/resolve-metadata.js), so the home-screen
  // icon would silently disappear.
  it('declares no icons, leaving them to the file conventions', () => {
    expect(metadata.icons).toBeUndefined()
  })

  it('tells iOS it can run standalone, with a status bar that suits the white header', () => {
    expect(metadata.appleWebApp).toEqual({
      capable: true,
      title: 'EveryDollar',
      statusBarStyle: 'default',
    })
  })
})
