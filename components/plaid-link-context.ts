'use client'

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

export type CompleteResult = { ok: true; warning?: string } | { ok: false; error: string }

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
  if (!ctx) return { ok: false, error: 'That connection attempt expired. Please start again.' }

  try {
    const res =
      ctx.mode === 'add'
        ? await fetch('/api/plaid/exchange-public-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              public_token,
              institution_name: metadata?.institution?.name ?? null,
              products: ctx.products ?? ['transactions'],
            }),
          })
        : await fetch('/api/plaid/reconnect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId: ctx.itemId }),
          })

    const body = (await res.json().catch(() => ({}))) as { error?: string; warning?: string }
    if (!res.ok) {
      return { ok: false, error: body.error ?? "That didn't save. Don't try again yet." }
    }
    clearPendingLink()
    return { ok: true, warning: body.warning }
  } catch {
    return { ok: false, error: "Couldn't reach the app. Check your connection, then retry." }
  }
}
