'use client'

import { SAVE_TIMEOUT_MS, sendRequest } from '@/lib/save-response'

// Plaid Link survives an OAuth round-trip (bank's own site → back to /plaid/oauth, a completely
// fresh page load) by stashing what it needs in localStorage. Non-OAuth banks never leave the page
// and read the same context in place. Both finish through completePendingLink.
//
// SSR GUARD, NON-NEGOTIABLE: /plaid/oauth is a client page with no dynamic APIs, so Next 16
// prerenders it at build time and these functions run on the server during `next build`. Guard on
// `typeof window`, NOT `typeof localStorage` — Node 22 defines a localStorage global, so the usual
// defensive check passes and the build still dies with "localStorage.getItem is not a function".
export type PendingLink = {
  token: string
  mode: 'add' | 'update'
  products?: string[]
  itemId?: string
  createdAt: number
}

const KEY = 'plaid_pending_link'

// Plaid link tokens expire: 4 hours for a new bank, 30 MINUTES in update mode. Expire ours
// slightly sooner so the user gets a plain "start again" instead of an opaque Link failure.
const MAX_AGE_MS = { add: 3 * 60 * 60 * 1000, update: 25 * 60 * 1000 }

export function savePendingLink(p: Omit<PendingLink, 'createdAt'>) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(KEY, JSON.stringify({ ...p, createdAt: Date.now() }))
}

export function loadPendingLink(): PendingLink | null {
  if (typeof window === 'undefined') return null
  const v = window.localStorage.getItem(KEY)
  if (!v) return null
  let ctx: PendingLink
  try {
    ctx = JSON.parse(v) as PendingLink
  } catch {
    clearPendingLink()
    return null
  }
  // A context left behind by an abandoned flow must not be silently resumed later.
  const maxAge = MAX_AGE_MS[ctx.mode] ?? MAX_AGE_MS.add
  if (!ctx.createdAt || Date.now() - ctx.createdAt > maxAge) {
    clearPendingLink()
    return null
  }
  return ctx
}

export function clearPendingLink() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(KEY)
}

// How long to wait for the public-token exchange before saying the bank may have connected (#165).
// It must outlast the route: given up on while the exchange was still running, and called a
// failure, the person links again, which makes a duplicate and spends a second of the ten
// connections (#51). The route pins its limit at 300 seconds (maxDuration in
// app/api/plaid/exchange-public-token/route.ts: Vercel's default, and the most Hobby allows), and
// the extra minute covers the request reaching it: the network, proxy.ts's session check, a cold
// start. So when this fires the exchange has finished or been stopped, and the reload shows which.
// tests/unit/exchange-public-token-route.test.ts fails if the two drift.
export const EXCHANGE_TIMEOUT_MS = 360_000

export type CompleteResult =
  | { outcome: 'done'; warning?: string }
  | { outcome: 'failed'; error: string }
  // The reply was lost, timed out or could not be read, so it may have worked. Callers say so, and
  // never that it failed.
  | { outcome: 'unknown' }

// Finish whatever Link just completed. Add mode → exchange the public token for a stored,
// encrypted access token. Update mode (reconnect) → the access token is unchanged, so we just
// tell the server the item is healthy again and resync it.
//
// RETURNS ITS OUTCOME, and only clears the saved context on success. By this point the Item
// already exists at Plaid, so a silent failure reads to the user as "nothing happened" and invites
// another click — which creates a SECOND Item and spends a second unrefundable slot. Public tokens
// stay valid ~30 minutes, so keeping the context means a retry actually retries.
export async function completePendingLink(
  public_token: string,
  metadata: { institution?: { name?: string } | null }
): Promise<CompleteResult> {
  const ctx = loadPendingLink()
  if (!ctx) return { outcome: 'failed', error: 'That connection attempt expired. Please start again.' }

  // The shared reply rules (lib/save-response.ts). The exchange waits EXCHANGE_TIMEOUT_MS, above. A
  // reconnect gets a save's timeout: update mode makes no Item, so trying again costs nothing, and
  // the reload shows whether the bank still needs it.
  const result =
    ctx.mode === 'add'
      ? await sendRequest(
          '/api/plaid/exchange-public-token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              public_token,
              institution_name: metadata?.institution?.name ?? null,
              products: ctx.products ?? ['transactions'],
            }),
          },
          EXCHANGE_TIMEOUT_MS
        )
      : await sendRequest(
          '/api/plaid/reconnect',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId: ctx.itemId }),
          },
          SAVE_TIMEOUT_MS
        )

  if (result.outcome === 'refused') return { outcome: 'failed', error: result.error }
  // Both routes answer ok: true when they finish, with a warning when the bank is linked but its
  // data has not arrived yet. An OK reply without it did not come from them.
  if (result.outcome === 'answered' && result.body.ok === true) {
    clearPendingLink()
    const warning = result.body.warning
    return { outcome: 'done', warning: typeof warning === 'string' ? warning : undefined }
  }
  console.error('[plaid] link reply lost or unreadable', ctx.mode, result.outcome === 'unknown' ? result.cause : result.body)
  return { outcome: 'unknown' }
}
