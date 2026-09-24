'use client'

import { useState, type ComponentProps } from 'react'
import { AccountCard } from './AccountCard'

// How many accounts are worth the thumb below `md`. Accounts are reference material rather than
// the reason the page was opened (§4), and the household has twelve.
const COLLAPSED = 4

type Account = ComponentProps<typeof AccountCard>['account']

export function AccountList({ accounts }: { accounts: Account[] }) {
  const [expanded, setExpanded] = useState(false)
  if (accounts.length === 0) return null

  // Below `md` the list is cut to COLLAPSED until asked; from `md` up the grid has the room and
  // this stage does not touch desktop, so every card is rendered and the extras are revealed with
  // CSS rather than being absent from the document.
  const hidden = accounts.slice(COLLAPSED)
  const canCollapse = hidden.length > 0

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {accounts.slice(0, COLLAPSED).map((a) => (
          <AccountCard key={a.id} account={a} />
        ))}
        {hidden.map((a) => (
          // Present in the document at every width. The wrapper is new markup, but `md:contents`
          // removes it from the box tree at `md` and up, leaving each card a direct grid child —
          // so the desktop grid renders exactly as it did. `hidden` below `md` keeps the extras
          // out of the phone list AND out of the accessibility tree until the reader asks.
          <div
            key={a.id}
            data-account-extra
            className={expanded ? 'contents' : 'hidden md:contents'}
          >
            <AccountCard account={a} />
          </div>
        ))}
      </div>
      {canCollapse && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="text-sm font-medium text-emerald hover:text-emerald-600 md:hidden"
        >
          {expanded ? 'Show fewer' : `Show all ${accounts.length}`}
        </button>
      )}
    </div>
  )
}
