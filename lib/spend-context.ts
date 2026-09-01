import { pfcToName, nonSpendingNames, transferNames, type Category } from './categories'
import { reimbursableByTxn, type ReimbursableTxn } from './reimbursements'

// Everything the spending calculations need, assembled once per page. Bundled into one object
// because the five money surfaces used to assemble these by hand: a page that forgot the reimbursable
// map would still compile and silently report reimbursable money as spending.
export type SpendContext = {
  pfcMap: Record<string, string> // Plaid PFC primary -> category NAME
  nonSpending: Set<string> // income + transfers (excluded from spending)
  transfers: Set<string> // transfers only (excluded from income too)
  reimbursedByTxn: Record<string, number> // transaction id -> reimbursable amount
}

// `txns` are the surface's OWN rows. Reimbursable now lives on the transaction, so the map is built
// from what the page already fetched — there is no second query to forget, and no window mismatch
// between the transactions and the thing that modifies them. This deletes the whole class of bug the
// old `writeOffs` field existed to prevent, by removing the second source of data rather than
// guarding it.
export function buildSpendContext(input: {
  categories: Category[]
  txns: ReimbursableTxn[]
}): SpendContext {
  return {
    pfcMap: pfcToName(input.categories),
    nonSpending: nonSpendingNames(input.categories),
    transfers: transferNames(input.categories),
    reimbursedByTxn: reimbursableByTxn(input.txns),
  }
}
