'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { money } from '@/lib/format'
import { Card } from './ui/Card'
import { Button } from './ui/Button'
import { ConfirmDialog } from './ui/ConfirmDialog'
import type { ClaimTotals } from '@/lib/reimbursements'

export type ClaimRow = {
  id: string
  name: string
  written_off_on: string | null
  oldestUnpaidDays: number | null
  totals: ClaimTotals
}

type Pending = { claim: ClaimRow; mode: 'write_off' | 'delete' }

export function ClaimList({ claims }: { claims: ClaimRow[] }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act({ claim, mode }: Pending) {
    setBusy(true)
    setError(null)
    try {
      const res =
        mode === 'delete'
          ? await fetch('/api/reimbursements/claims', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: claim.id }),
            })
          : await fetch('/api/reimbursements/claims', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'write_off', id: claim.id }),
            })
      if (!res.ok) {
        // e.g. someone wrote this claim off in another tab between page load and this click —
        // the server is the source of truth, so surface its message rather than pretending it
        // worked.
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'That action could not be completed.')
        return
      }
      setConfirming(null)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  if (!claims.length) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm text-muted">
          Nothing outstanding. Split a transaction from the Transactions page to start tracking money
          someone owes you.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}

      {claims.map((c) => {
        const pct =
          c.totals.owed > 0 ? Math.round((c.totals.returned / c.totals.owed) * 100) : 0
        return (
          <Card key={c.id} className="p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-ink">{c.name}</h2>
              <span className="text-xs text-faint">
                {c.totals.writtenOff
                  ? `Written off ${c.written_off_on ? new Date(c.written_off_on).toLocaleDateString() : ''}`
                  : c.totals.settled
                    ? 'Settled'
                    : `${money(c.totals.outstanding)} outstanding`}
              </span>
            </div>

            <p className="mt-1 text-sm text-muted">
              {money(c.totals.owed)} owed · {money(c.totals.returned)} back
              {c.oldestUnpaidDays != null && !c.totals.settled && !c.totals.writtenOff && (
                <> · oldest unpaid {c.oldestUnpaidDays}d</>
              )}
            </p>

            <div
              className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2"
              role="progressbar"
              aria-valuenow={Math.min(100, pct)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${c.name} repaid`}
            >
              <div className="h-full bg-emerald" style={{ width: `${Math.min(100, pct)}%` }} />
            </div>

            {c.totals.byPerson.length > 0 && (
              <ul className="mt-4 space-y-1 text-sm">
                {c.totals.byPerson.map((p) => (
                  <li key={p.owedBy} className="flex items-center justify-between">
                    <span className="text-ink">{p.owedBy}</span>
                    <span className="tabular-nums text-muted">
                      {p.outstanding <= 0
                        ? 'paid'
                        : `${money(p.outstanding)} outstanding`}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 flex gap-2">
              {!c.totals.writtenOff && !c.totals.settled && (
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={`Write off ${c.name}`}
                  onClick={() => setConfirming({ claim: c, mode: 'write_off' })}
                >
                  Write off
                </Button>
              )}
              {/* A written-off claim's write-off rows are a frozen record of spending that already
                  counted in a (possibly closed) month — the API refuses to delete it (400) because
                  deleting would cascade those rows and retroactively change that month. Open and
                  settled claims have no such frozen record, so both stay deletable. */}
              {!c.totals.writtenOff && (
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={`Delete ${c.name}`}
                  onClick={() => setConfirming({ claim: c, mode: 'delete' })}
                >
                  Delete
                </Button>
              )}
            </div>
          </Card>
        )
      })}

      <ConfirmDialog
        open={confirming !== null}
        title={
          confirming?.mode === 'delete'
            ? `Delete ${confirming.claim.name}?`
            : `Write off ${confirming?.claim.name ?? ''}?`
        }
        confirmLabel={confirming?.mode === 'delete' ? 'Delete it' : 'Write it off'}
        busy={busy}
        onConfirm={() => confirming && act(confirming)}
        onCancel={() => setConfirming(null)}
      >
        {confirming?.mode === 'delete'
          ? 'This removes the claim and all its splits, so the money it was excluding goes back to counting as spending in the months it happened.'
          : `${money(confirming?.claim.totals.outstanding ?? 0)} will be counted as spending this month, in the categories it came from. This can't be undone.`}
      </ConfirmDialog>
    </div>
  )
}
