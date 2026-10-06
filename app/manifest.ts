import type { MetadataRoute } from 'next'

// Served at /manifest.webmanifest, and Next adds the <link> to every page. It makes the app
// installable: from the home screen it opens standalone, with no browser toolbar, which is also
// what fixes #128 (the collapsed iOS toolbar taking the first tap on the tab bar).
//
// Colours are the design tokens in app/globals.css: the launch screen is the canvas, and the
// browser UI is the white of the phone header. The icons come from scripts/generate-icons.mjs.
// The proxy matcher skips these paths by name (proxy.ts), because browsers fetch the manifest
// without cookies.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Every Dollar Counts',
    short_name: 'EveryDollar',
    description: 'A simple household budget tracker',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#f4f6f3',
    theme_color: '#ffffff',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
