// Reading the "isn't syncing" banner off a page's unrendered tree (#135). A Server Component returns
// its element tree with child components unrendered, so the banner shows up as an element; these
// find it where the page put it and render just that element, the way the browser would get it.
import type { ReactElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { NotSyncingBanner } from '@/components/NotSyncingBanner'

type Block = { type: unknown; props: Record<string, unknown> }

// A page's top-level blocks in order, leaving out the ones it did not render (false or null).
export function blocks(tree: unknown): Block[] {
  const kids = (tree as { props: { children: unknown } }).props.children
  return ([] as unknown[]).concat(kids).flat().filter(Boolean) as Block[]
}

// What the banner says: empty when it renders nothing, as when every bank is syncing. Throws when
// the page placed no banner at all.
export function bannerText(tree: unknown): string {
  const banner = blocks(tree).find((b) => b.type === NotSyncingBanner)
  if (!banner) throw new Error('the page rendered no NotSyncingBanner')
  const { container } = render(banner as ReactElement)
  const text = container.textContent ?? ''
  cleanup()
  return text
}
