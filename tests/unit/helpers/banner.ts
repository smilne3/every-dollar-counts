// Reading the "isn't syncing" banner (#135) and the missing-balances note (#170) off a page's
// unrendered tree. A Server Component returns its element tree with child components unrendered, so
// each shows up as an element; these find it where the page put it and read what it says.
import type { ReactElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { NotSyncingBanner } from '@/components/NotSyncingBanner'
import { MissingBalancesNote } from '@/components/MissingBalancesNote'
import { RefreshButton } from '@/components/RefreshButton'

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

// What the note says, and whether it offers Refresh: null when it renders nothing, as when every
// bank has accounts. Read off the tree the note returns, unrendered below it, because RefreshButton
// needs the app router: that it is there is the page's business, and what it does is
// tests/unit/refresh-button.test.tsx's. Throws when the page placed no note at all.
export function balancesNote(tree: unknown): { text: string; refresh: boolean } | null {
  const note = blocks(tree).find((b) => b.type === MissingBalancesNote)
  if (!note) throw new Error('the page rendered no MissingBalancesNote')
  const out = MissingBalancesNote(note.props as Parameters<typeof MissingBalancesNote>[0])
  if (out === null) return null
  const text: string[] = []
  let refresh = false
  const walk = (n: unknown): void => {
    if (n == null || typeof n === 'boolean') return
    if (typeof n === 'string' || typeof n === 'number') {
      text.push(String(n))
      return
    }
    if (Array.isArray(n)) return n.forEach(walk)
    const el = n as { type?: unknown; props?: { children?: unknown } }
    if (el.type === RefreshButton) refresh = true
    walk(el.props?.children)
  }
  walk(out)
  return { text: text.join(''), refresh }
}
