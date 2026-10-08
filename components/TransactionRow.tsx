import { isCardPaymentRow } from '@/lib/categories'
import { changedByRule, type ResolvedCategory } from '@/lib/category-rules'
import { money } from '@/lib/format'
import { presentTransaction, TONE_CLASS } from '@/lib/transaction-presentation'
import { CategoryPicker } from './CategoryPicker'
import { LearnedMarker } from './LearnedMarker'
import { ReimbursableCheckbox } from './ReimbursableCheckbox'
import { ReimbursableEditor } from './ReimbursableEditor'

type Txn = {
  id: string
  date: string
  name: string | null
  merchant_name: string | null
  amount: number
  // What identify a credit-card payment, which the reimbursable route refuses, so the checkbox must
  // not be offered on one. Both are already selected by the page.
  user_category: string | null
  pfc_primary: string | null
  pfc_detailed: string | null
  reimbursable_amount: number | null
  reimbursable_note: string | null
}

export function TransactionRow({
  t,
  category,
  categoryOptions,
}: {
  t: Txn
  category: ResolvedCategory
  categoryOptions: string[]
}) {
  // Meaning (sign convention, colour rule, card-payment exemption) lives once in
  // lib/transaction-presentation.ts so the phone card can't drift from this table.
  const { label, display, tone, isCC, shareAmount } = presentTransaction(t)
  const marked = Number(t.reimbursable_amount ?? 0)
  // Not isCC: that turns false once someone has picked a category, and the route refuses to change
  // ANY card payment (#28). A card payment shows its pick as text, never a picker that always fails.
  const cardPayment = isCardPaymentRow(t.pfc_detailed)

  return (
    <tr className="border-b border-line transition-colors hover:bg-surface-2">
      <td className="px-4 py-3 whitespace-nowrap text-sm text-muted">{t.date}</td>
      {/* Truncated rather than wrapped: a fixed column would otherwise give one long merchant a
          two-line row and leave the table's rhythm uneven. `title` keeps the full name reachable. */}
      <td className="truncate px-4 py-3 font-medium text-ink" title={label}>
        {label}
      </td>
      {/* No category picker on a card payment. Setting user_category makes isCreditCardPayment
          return false — the deliberate "user override wins" rule — which re-enters that row into
          the totals (each leg of a card payment is its own row, so only the picked leg returns).
          Measured on a real $7,866.69 payment: picking a spending category takes September
          spending from $3,949.16 to MINUS $3,917.53; picking Income invents $7,866.69 of income.
          Only the two Transfer categories are harmless. A control where most choices silently
          corrupt the numbers by thousands does not belong on the row, and "Loan Payments" was
          never what this is anyway. The same reasoning hides the reimbursable box and the editor
          on an UNPICKED card payment (they follow isCC). A card payment someone filed by hand
          before #28, or picked before Plaid re-tagged the row as a card payment, shows that pick
          as text: the categorize route refuses to change any card payment. */}
      <td className="px-4 py-3">
        {cardPayment ? (
          <span className="text-sm text-muted">{t.user_category ?? 'Card payment'}</span>
        ) : (
          // One horizontal line (#28 spec §8.1, plan Ruling 1): the picker fills what the marker
          // leaves, and the marker never wraps under it. items-start: a save error shows under the
          // select and grows this one row (PR 1), and the marker stays beside the select, not
          // centred on the taller cell.
          <span className="flex min-w-0 flex-nowrap items-start gap-1.5">
            <span className="min-w-0 flex-1">
              <CategoryPicker
                transactionId={t.id}
                value={category.name}
                source={category.source}
                options={categoryOptions}
                label={label}
              />
            </span>
            {changedByRule(category) && <LearnedMarker category={category.name} merchant={t.merchant_name} />}
          </span>
        )}
      </td>
      {/* A credit-card payment is neither spending nor income — it moves your own money between two
          of your own accounts, and every total already skips both legs (#31). It was still painted
          emerald on the leg that credits the card, which is the colour this table uses for money
          arriving, so a $7,866.69 card payment read as income. Muted says "this is not new money"
          without hiding a transaction that genuinely happened on the statement. */}
      <td
        className={`px-4 py-3 text-right font-medium tabular-nums ${TONE_CLASS[tone]}`}
      >
        {money(display)}
        {/* ALWAYS rendered, merely hidden when unmarked. Conditionally mounting this line meant
            ticking the box added a second line to the cell, which grew the row and pushed every
            row beneath it down the page — the reader's place jumps on every tick (#50).
            `invisible` is visibility:hidden, so the space stays reserved and assistive tech still
            skips it. Where the row's height is already set by the taller category control, the
            reserved line costs nothing at all. */}
        {/* nowrap: the Amount column is 160px, and "your share -$12,345.67" would wrap to two lines
            at text-xs — reintroducing the very row growth the reserved line exists to prevent. */}
        <span
          className={`block truncate text-xs font-normal whitespace-nowrap text-faint ${
            marked > 0 || isCC ? '' : 'invisible'
          }`}
        >
          {/* The line is reserved on every row anyway, so saying what a card payment is costs no
              height — but the Amount column is 160px and this is nowrap, so the words have to fit
              in it. The column is w-40 (160px) minus px-4 either side = 128px of content, which at
              text-xs is about 19 characters. "moves between your accounts" (27) and then "between
              your accounts" (21) both truncated to an ellipsis that explains nothing. Anything put
              here must fit ~19 characters — measure, do not estimate.
              An outflow's share is money out (shown negative); an inflow's untagged remainder is
              money in (shown positive) — matching the `display` convention above. */}
          {isCC ? 'between accounts' : shareAmount !== null ? `your share ${money(shareAmount)}` : ' '}
        </span>
      </td>
      {/* Its own column, under a "Reimbursable" header: the word used to be printed in every cell,
          which is the header's job. */}
      <td className="px-4 py-3 text-right">
        <ReimbursableCheckbox
          transactionId={t.id}
          amount={t.amount}
          reimbursableAmount={t.reimbursable_amount}
          note={t.reimbursable_note}
          label={label}
          pfcDetailed={t.pfc_detailed}
          userCategory={t.user_category}
        />
      </td>
      {/* The editor owns its own trigger now. A menu wrapper made sense when it might hold several
          actions; with exactly one it was ceremony, and on a credit-card payment it opened onto an
          empty panel. Nothing renders here for those rows instead. */}
      <td className="px-4 py-3 text-right">
        {!isCC && (
          <ReimbursableEditor
            transactionId={t.id}
            amount={t.amount}
            reimbursableAmount={t.reimbursable_amount}
            note={t.reimbursable_note}
            label={label}
            date={t.date}
          />
        )}
      </td>
    </tr>
  )
}
