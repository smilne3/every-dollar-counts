import { pfcToName, nonSpendingNames, transferNames, type Category } from './categories'
import { reimbursedByTxn, type Split } from './reimbursements'

// Everything the spending calculations need, assembled once per page. Bundled into one object
// because the five money surfaces used to assemble these by hand: a page that forgot to pass the
// split totals would still compile and silently report reimbursable money as spending.
export type SpendContext = {
  pfcMap: Record<string, string> // Plaid PFC primary -> category NAME
  nonSpending: Set<string> // income + transfers (excluded from spending)
  transfers: Set<string> // transfers only (excluded from income too)
  reimbursedByTxn: Record<string, number> // transaction id -> reimbursable amount
}

export function buildSpendContext(input: {
  categories: Category[]
  splits: Split[]
}): SpendContext {
  return {
    pfcMap: pfcToName(input.categories),
    nonSpending: nonSpendingNames(input.categories),
    transfers: transferNames(input.categories),
    reimbursedByTxn: reimbursedByTxn(input.splits),
  }
}
