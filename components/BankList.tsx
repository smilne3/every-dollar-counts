'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ReconnectButton } from '@/components/ReconnectButton'
import { buttonClass } from '@/components/ui/Button'
import type { ItemSummary } from '@/lib/plaid-items'

// Plaid's own wording for the codes that need action at the bank. A Reconnect button for these
// would just fail again and push the user toward a relink, which spends an unrefundable slot.
const AT_BANK_COPY: Record<string, string> = {
  ITEM_LOCKED: 'Your account is locked. Unlock it on the bank’s website, then press Refresh.',
  PASSWORD_RESET_REQUIRED:
    'The bank wants a new password. Reset it on their website, then press Refresh.',
  USER_SETUP_REQUIRED: 'The bank needs you to finish something on their website, then Refresh.',
  INSUFFICIENT_CREDENTIALS: 'The bank sign-in wasn’t completed. Try connecting again.',
  ITEM_NOT_SUPPORTED: 'This bank can’t share this account with Plaid.',
  NO_ACCOUNTS: 'No open accounts were found at this bank.',
}

function statusLine(item: ItemSummary) {
  switch (item.status) {
    case 'needs_reconnect':
      return { tone: 'coral', text: 'Connection lost — reconnect to resume syncing.' }
    case 'action_at_bank':
      return {
        tone: 'coral',
        text:
          AT_BANK_COPY[item.status_detail ?? ''] ??
          'This bank needs something from you on their website, then press Refresh.',
      }
    case 'temporarily_unavailable':
      return { tone: 'muted', text: 'This bank didn’t respond last time. Nothing to do — try Refresh later.' }
    case 'config_error':
      return {
        tone: 'coral',
        text: `Something is wrong with this connection's setup (${item.status_detail ?? 'unknown'}). Reconnecting won't fix it.`,
      }
    default:
      return { tone: 'muted', text: 'Connected' }
  }
}

export function BankList({ items }: { items: ItemSummary[] }) {
  const router = useRouter()
  const [pendingRemove, setPendingRemove] = useState<ItemSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function disconnect(item: ItemSummary) {
    setBusy(true)
    const res = await fetch('/api/plaid/remove-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: item.id }),
    }).catch(() => null)
    setBusy(false)
    setPendingRemove(null)
    // A failed disconnect means the bank is STILL connected at Plaid. Saying nothing would let the
    // user believe a real credential had been revoked when it hadn't.
    if (!res || !res.ok) {
      const body = res ? await res.json().catch(() => ({}) as { error?: string }) : {}
      setError(body.error ?? 'That bank was NOT disconnected. It is still connected at Plaid.')
      return
    }
    setError(null)
    router.refresh()
  }

  return (
    <>
      {error && <p className="pb-2 text-sm text-coral">{error}</p>}
      {/* The slot budget has to be visible, not remembered: 10 lifetime, never refunded. */}
      <p className="pb-2 text-xs text-muted">
        Bank connections used: {items.length} of 10. Disconnecting one does not give it back.
      </p>

      {items.length === 0 ? (
        <p className="text-sm text-muted">No banks connected yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => {
            const s = statusLine(item)
            return (
              <li key={item.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {item.institution_name ?? 'Linked bank'}
                  </p>
                  <p className={`text-xs ${s.tone === 'coral' ? 'text-coral' : 'text-muted'}`}>
                    {s.text}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {item.status === 'needs_reconnect' && <ReconnectButton itemId={item.id} />}
                  <button
                    onClick={() => setPendingRemove(item)}
                    className={buttonClass('secondary', 'sm')}
                  >
                    Disconnect
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        title={`Disconnect ${pendingRemove?.institution_name ?? 'this bank'}?`}
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={() => pendingRemove && disconnect(pendingRemove)}
        onCancel={() => setPendingRemove(null)}
      >
        <p>This removes the bank and deletes its accounts and transactions.</p>
        <p>
          Your Plaid connection slot is <strong>not</strong> refunded — re-linking later counts as a
          new connection, and you only get ten.
        </p>
      </ConfirmDialog>
    </>
  )
}
