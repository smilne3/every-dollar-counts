'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ReconnectButton } from '@/components/ReconnectButton'
import { buttonClass } from '@/components/ui/Button'
import type { ItemSummary } from '@/lib/plaid-items'
import { sendSave } from '@/lib/save-response'

// For a Disconnect whose reply was lost, timed out or could not be read (#165). Plaid may have
// revoked the bank and its row may be gone, so "still connected" would be a guess. The reload shows
// whether it is still listed.
const MAY_HAVE_DISCONNECTED = 'That bank may or may not have been disconnected. Showing the latest.'

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

export function BankList({
  items,
  slotsUsed = null,
  lifetimeSlots,
}: {
  items: ItemSummary[]
  // How many of the lifetime allowance have been spent, or null when it cannot be established
  // (#51). Null keeps the old wording rather than printing a number we do not stand behind.
  slotsUsed?: number | null
  lifetimeSlots: number
}) {
  const router = useRouter()
  const [pendingRemove, setPendingRemove] = useState<ItemSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A reconnect's warning that its transactions have not arrived yet, shown as LinkButton shows its
  // notice. Held here: the ReconnectButton that hears it is gone once the reload shows the bank
  // healthy (#165).
  const [notice, setNotice] = useState<string | null>(null)

  async function disconnect(item: ItemSummary) {
    setBusy(true)
    setError(null)
    setNotice(null)
    let reload = false
    try {
      // The shared rule (lib/save-response.ts): only the route's own { ok: true } is a disconnect.
      const result = await sendSave('/api/plaid/remove-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id }),
      })
      if (result.outcome === 'saved') {
        reload = true
      } else if (result.outcome === 'refused') {
        // Shown as it stands: the route's words say what is true of the bank at Plaid on each path,
        // including whether it is still connected. A 404 means it is already gone, so the list is
        // stale.
        setError(result.error)
        reload = result.status === 404
      } else {
        // Saying it failed would be a guess either way: a person told a bank is still connected
        // when it is not, or the reverse, acts on the wrong one.
        console.error('[BankList] disconnect failed', result.cause)
        setError(MAY_HAVE_DISCONNECTED)
        reload = true
      }
    } finally {
      // Never left with the dialog's buttons disabled.
      setBusy(false)
      setPendingRemove(null)
    }
    // Outside the try: a throw from refresh is not a failed disconnect.
    if (reload) router.refresh()
  }

  return (
    <>
      {error && (
        <p role="alert" className="pb-2 text-sm text-coral">
          {error}
        </p>
      )}
      {notice && <p className="pb-2 text-sm text-muted">{notice}</p>}
      {/* "N of 10 used" was deliberately NOT printed here for a long time, and the reason was
          sound: the only number available was the count of LIVE banks, which falls on a disconnect
          — the opposite of the truth, since the slot stays spent. plaid_slot_ledger now survives
          the delete, so the honest number exists and can be shown (#51). Where it cannot be
          established the old wording stands rather than a figure we do not stand behind. */}
      <p className="pb-2 text-xs text-muted">
        {items.length} bank {items.length === 1 ? 'connection' : 'connections'} active.{' '}
        {slotsUsed == null ? (
          <>You get {lifetimeSlots} over the lifetime of the account, and disconnecting one does not free it up.</>
        ) : (
          <>
            <span className={slotsUsed >= lifetimeSlots ? 'font-medium text-coral' : slotsUsed >= lifetimeSlots - 2 ? 'font-medium text-amber' : undefined}>
              {slotsUsed} of {lifetimeSlots} lifetime connections used.
            </span>{' '}
            Disconnecting one does not give it back.
          </>
        )}
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
                  {item.status === 'needs_reconnect' && <ReconnectButton itemId={item.id} onNotice={setNotice} />}
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
