import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import manifest from '@/app/manifest'

// #21: the app installs to the home screen and launches without browser chrome. That is also the
// fix for #128, where the collapsed iOS browser toolbar swallowed the first tap on the tab bar —
// so `display: 'standalone'` is not cosmetic here.

const css = readFileSync('app/globals.css', 'utf8')
const token = (name: string) => css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]

// Width and height straight from the PNG's IHDR chunk, so a mislabelled `sizes` is caught.
function pngSize(path: string) {
  const buf = readFileSync(path)
  expect(buf.subarray(1, 4).toString()).toBe('PNG')
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`
}

describe('web app manifest', () => {
  const m = manifest()

  it('launches standalone at the dashboard, scoped to the whole app', () => {
    expect(m.display).toBe('standalone')
    expect(m.start_url).toBe('/dashboard')
    expect(m.scope).toBe('/')
    expect(m.id).toBe('/')
  })

  it('has a short name that fits under a home-screen icon', () => {
    expect(m.name).toBe('Every Dollar Counts')
    expect(m.short_name!.length).toBeLessThanOrEqual(12)
  })

  // The launch screen is the canvas; the browser UI matches the white phone header
  // (components/AppShell.tsx), so pine would put a dark band above a white bar.
  it('takes its colours from the design tokens', () => {
    expect(m.background_color).toBe(token('canvas'))
    expect(m.theme_color).toBe(token('surface'))
  })

  it('offers 192 and 512 icons, plus a maskable one', () => {
    const icons = m.icons ?? []
    const any = icons.filter((i) => i.purpose === undefined || i.purpose === 'any')
    expect(any.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512'])
    expect(icons.filter((i) => i.purpose === 'maskable').map((i) => i.sizes)).toEqual(['512x512'])
  })

  it('points every icon at a real PNG of the size it claims', () => {
    for (const icon of m.icons ?? []) {
      const path = `public${icon.src}`
      expect(existsSync(path), path).toBe(true)
      expect(icon.type).toBe('image/png')
      expect(pngSize(path), path).toBe(icon.sizes)
    }
  })
})

describe('icon files outside the manifest', () => {
  // app/icon.png and app/apple-icon.png are Next's file conventions: it emits the
  // <link rel="icon"> and <link rel="apple-touch-icon"> tags for them.
  // public/apple-touch-icon.png answers iOS's probe of the root path.
  it.each([
    ['app/icon.png', '32x32'],
    ['app/apple-icon.png', '180x180'],
    ['public/apple-touch-icon.png', '180x180'],
  ])('%s is %s', (path, size) => {
    expect(pngSize(path)).toBe(size)
  })
})
