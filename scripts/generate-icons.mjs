// Generates the app's icons (#21) from one drawing, so every size is the same mark: the emerald
// tile with a white "$" that the sidebar and login page already use (BrandMark in
// components/AppShell.tsx). Run with `npm run icons`; the PNGs are committed, so the build does not
// depend on this script.
//
// Rendered with Next's own ImageResponse, so no image dependency is added. Imported as
// 'next/og.js' through require: next has no `exports` map and og.js is CommonJS, so a bare
// `import 'next/og'` does not resolve under Node's ESM loader.
//
// The "$" is an SVG path rather than text. Text would make ImageResponse fetch a font, and the
// glyph would then depend on whichever font that was.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { ImageResponse } = require('next/og.js')
const { createElement: h } = require('react')

const root = fileURLToPath(new URL('..', import.meta.url))

// The brand colour comes from the stylesheet, so the icons cannot drift from the app.
const css = readFileSync(`${root}app/globals.css`, 'utf8')
const emerald = css.match(/--color-emerald:\s*(#[0-9a-f]{6})/i)?.[1]
if (!emerald) throw new Error('--color-emerald not found in app/globals.css')

// A "$" in a 100×100 box: an S stroke with a bar through it.
function dollar(px) {
  return h(
    'svg',
    { width: px, height: px, viewBox: '0 0 100 100' },
    h('path', {
      d: 'M50 10 L50 90',
      stroke: '#ffffff',
      strokeWidth: 9,
      strokeLinecap: 'round',
      fill: 'none',
    }),
    h('path', {
      d: 'M68 31 C64 23 57 20 49 20 C39 20 31 26 31 35 C31 52 69 47 69 65 C69 74 60 80 50 80 C41 80 34 76 31 68',
      stroke: '#ffffff',
      strokeWidth: 10,
      strokeLinecap: 'round',
      fill: 'none',
    })
  )
}

// `rounded`: a rounded tile on transparency, for browsers that show the icon as given.
// Otherwise full-bleed and opaque, for platforms that apply their own mask (iOS, maskable).
// `glyph` is the "$" as a share of the icon's size.
async function render(file, size, { rounded, glyph }) {
  const tile = h(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: emerald,
        borderRadius: rounded ? Math.round(size * 0.22) : 0,
      },
    },
    dollar(Math.round(size * glyph))
  )
  const png = Buffer.from(await new ImageResponse(tile, { width: size, height: size }).arrayBuffer())
  writeFileSync(`${root}${file}`, png)
  console.log(`${file}  ${size}×${size}`)
}

// Maskable icons are cropped to a circle as small as 80% of the width, so the "$" stays well
// inside it. iOS rounds the corners itself and shows transparency as black, so its icons are opaque.
await render('app/icon.png', 32, { rounded: true, glyph: 0.78 })
await render('app/apple-icon.png', 180, { rounded: false, glyph: 0.62 })
await render('public/apple-touch-icon.png', 180, { rounded: false, glyph: 0.62 })
await render('public/icon-192.png', 192, { rounded: true, glyph: 0.62 })
await render('public/icon-512.png', 512, { rounded: true, glyph: 0.62 })
await render('public/icon-maskable-512.png', 512, { rounded: false, glyph: 0.5 })
