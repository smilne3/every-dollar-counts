import { pfcToName, nonSpendingNames, transferNames, type Category } from './categories'
import {
  reimbursedByTxn,
  writeOffsAsTxns,
  type Split,
  type WriteOff,
  type WriteOffTxn,
} from './reimbursements'

// Everything the spending calculations need, assembled once per page. Bundled into one object
// because the five money surfaces used to assemble these by hand: a page that forgot to pass the
// split totals would still compile and silently report reimbursable money as spending.
export type SpendContext = {
  pfcMap: Record<string, string> // Plaid PFC primary -> category NAME
  nonSpending: Set<string> // income + transfers (excluded from spending)
  transfers: Set<string> // transfers only (excluded from income too)
  reimbursedByTxn: Record<string, number> // transaction id -> reimbursable amount
  // The frozen spending of written-off claims, for the SAME date window as the surface's
  // transactions. It lives here for exactly the reason the rest of the object does: written-off
  // money is spending, and a surface that forgot it would still compile while under-reporting. It
  // is carried as the stored rows rather than pre-concatenated because each surface decides WHERE
  // in its own pipeline they join the list — see withWriteOffs.
  writeOffs: WriteOff[]
}

export function buildSpendContext(input: {
  categories: Category[]
  splits: Split[]
  // Required, not optional: the whole point of the field is that a sixth money surface cannot
  // forget it. Pass [] only where write-offs genuinely do not apply.
  writeOffs: WriteOff[]
}): SpendContext {
  return {
    pfcMap: pfcToName(input.categories),
    nonSpending: nonSpendingNames(input.categories),
    transfers: transferNames(input.categories),
    reimbursedByTxn: reimbursedByTxn(input.splits),
    writeOffs: input.writeOffs,
  }
}

// A surface's real transactions plus its write-offs, as the transaction-shaped values the spending
// functions already understand (effectiveCategory honours user_category first, so each row lands in
// the category it was allocated to). Nothing is written to `transactions` — see writeOffsAsTxns.
//
// Call this at exactly the point the surface used to concatenate by hand: BEFORE any month
// filtering, so a write-off enters the month it is dated in, the same as a real transaction.
export function withWriteOffs<T>(txns: T[], ctx: SpendContext): (T | WriteOffTxn)[] {
  return [...txns, ...writeOffsAsTxns(ctx.writeOffs)]
}
