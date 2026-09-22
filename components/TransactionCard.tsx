'use client'

import { useState } from 'react'
import { money } from '@/lib/format'
import { presentTransaction, TONE_CLASS } from '@/lib/transaction-presentation'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { CategoryPicker } from '@/components/CategoryPicker'
import { ReimbursableCheckbox } from '@/components/ReimbursableCheckbox'
import { ReimbursableEditor } from '@/components/ReimbursableEditor'

type Txn = {
  id: string
  date: string
  name: string | null
  merchant_name: string | null
  amount: number
  user_category: string | null
  pfc_detailed: string | null
  reimbursable_amount: number | null
  reimbursable_note: string | null
}

// The phone presentation of one transaction. Takes the same three props as TransactionRow so the
// page can map one list with either, and derives every displayed value from presentTransaction so
// the two cannot disagree about what the transaction is.
export function TransactionCard({
  t,
  categoryName,
  categoryOptions,
}: {
  t: Txn
  categoryName: string
  categoryOptions: string[]
}) {
  const [open, setOpen] = useState(false)
  // Whether either control inside the sheet has a PATCH outstanding. Tracked per child rather than
  // as a counter so a double-report cannot leave the sheet permanently unclosable.
  //
  // This exists because the sheet's children are UNMOUNTED on close (see the gate below). Both
  // controls set their error state after the await, and React silently no-ops a setState on an
  // unmounted component — with no client-side telemetry, a save that failed in that window was
  // recorded nowhere and shown to nobody. Tap the tick, tap Done: one thumb movement on a phone,
  // and the user walks away believing the mark happened.
  //
  // The desktop row never had this — its checkbox is mounted for the life of the page, so its
  // error stands until the reader navigates. Closing is therefore withheld, not the error
  // relocated: the request is allowed to land where its failure already knows how to render.
  const [checkboxBusy, setCheckboxBusy] = useState(false)
  const [editorBusy, setEditorBusy] = useState(false)
  // `label` is never null — presentTransaction owns the fallback so this card and the desktop row
  // cannot answer "what is this called?" differently (spec §9).
  const { label: name, display, tone, isCC, shareAmount } = presentTransaction(t)
  // Gated on isCC as well, so that a refresh which turns this row INTO a card payment — removing
  // both controls from the sheet — cannot leave a stale "in flight" behind and lock the sheet shut
  // for good. Holding someone inside a sheet they cannot leave is a worse bug than the one this
  // is here to prevent, so the state that withholds the exit is tied to the controls existing.
  const busy = !isCC && (checkboxBusy || editorBusy)
  const categoryLabel = isCC ? 'Card payment' : categoryName
  const shareLabel = shareAmount !== null ? `, your share ${money(shareAmount)}` : ''

  // The whole row is the control: a 390px row has no room for a separate affordance, and the
  // sheet is the only place the category and reimbursable controls fit (spec §3.2).
  //
  // aria-label REPLACES the button's accessible name rather than augmenting it, so without the
  // category and share text here a screen-reader user hears only merchant + amount — never "Card
  // payment" or "your share …", which is exactly the information the meta line exists to surface
  // for sighted users. The phone is this household's primary device, so this is not hypothetical.
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${name}, ${categoryLabel}, ${money(display)}${shareLabel} — edit`}
        className="flex w-full items-start justify-between gap-3 border-b border-line px-4 py-3 text-left transition-colors last:border-b-0 active:bg-surface-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink">{name}</span>
          <span className="mt-0.5 block truncate text-xs text-muted">
            {t.date} · {categoryLabel}
            {shareAmount !== null && ` · your share ${money(shareAmount)}`}
          </span>
        </span>
        <span className={`shrink-0 font-medium tabular-nums ${TONE_CLASS[tone]}`}>{money(display)}</span>
      </button>

      <Dialog
        open={open}
        title={name}
        // Escape and the Android back gesture come through onCancel; `busy` makes Dialog withhold
        // them, and Done is disabled for the same window. Both routes out, because either one
        // unmounts the request underneath itself. The wait is one round trip, and it is exactly
        // the precedent ReimbursableEditor already sets for its own Cancel and Save.
        busy={busy}
        onCancel={() => setOpen(false)}
        footer={
          <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
            Done
          </Button>
        }
      >
        {/* Mounted only while the sheet is open. PER_PAGE is 200 and both layouts render for every
            transaction, so a closed sheet per row shipped a <select> of 19 <option>s, a checkbox,
            an editor and ReimbursableEditor's own second, nested <dialog> — 45 of a card's 55
            elements, at every viewport, for markup nobody had asked to see. Measured with
            renderToStaticMarkup over 200 transactions: 1,756 KB against 1,010 KB gated, on a
            pre-branch baseline of 778 KB, and 381 <dialog> elements against 200.

            The <Dialog> itself stays mounted. Unmounting that would take the native <dialog> with
            it, and with it the focus restoration that returns focus to this card's button on close
            (Dialog.tsx handles the part of that which unmounting these children does break). */}
        {open && (
          <>
            <p className={`mt-1 text-sm tabular-nums ${TONE_CLASS[tone]}`}>
              {t.date} · {money(display)}
            </p>

            {isCC ? (
              // Same exemption the desktop row enforces. A user_category here re-enters both legs
              // of the payment into every total — see TransactionRow.tsx:48-58.
              <p className="mt-4 text-sm text-muted">Card payment — moves between your accounts.</p>
            ) : (
              <div className="mt-4 flex flex-col gap-4">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-semibold uppercase tracking-wide text-faint">Category</span>
                  <CategoryPicker
                    transactionId={t.id}
                    value={categoryName}
                    options={categoryOptions}
                    label={name}
                  />
                </label>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-faint">Reimbursable</span>
                  <ReimbursableCheckbox
                    transactionId={t.id}
                    amount={t.amount}
                    reimbursableAmount={t.reimbursable_amount}
                    note={t.reimbursable_note}
                    label={name}
                    pfcDetailed={t.pfc_detailed}
                    userCategory={t.user_category}
                    onBusyChange={setCheckboxBusy}
                  />
                </div>

                <ReimbursableEditor
                  transactionId={t.id}
                  amount={t.amount}
                  reimbursableAmount={t.reimbursable_amount}
                  note={t.reimbursable_note}
                  label={name}
                  date={t.date}
                  onBusyChange={setEditorBusy}
                />
              </div>
            )}
          </>
        )}
      </Dialog>
    </>
  )
}
