import { isLiability } from '@/lib/dashboard'

// A row for the Net Worth / Cash breakdown. Carries account_id (Plaid's text id) because that is
// what the transactions drill-down filters on — NOT the internal `id` uuid.
export type BreakdownAccount = {
  id: string
  account_id: string
  name: string
  subtype: string | null
  balance: number
  owed: boolean
}

type RawAccount = {
  id: string
  account_id: string
  name: string | null
  type: string | null
  subtype: string | null
  current_balance: number | null
}

const ASSET_TYPES = new Set(['depository', 'investment', 'other'])

// Split accounts into assets and liabilities with per-side totals and the net. Mirrors netWorth()
// in lib/dashboard.ts so the breakdown page and the Net Worth tile can never disagree.
export function groupAccountsByKind(accounts: RawAccount[]): {
  assets: BreakdownAccount[]
  liabilities: BreakdownAccount[]
  assetTotal: number
  liabilityTotal: number
  net: number
} {
  const assets: BreakdownAccount[] = []
  const liabilities: BreakdownAccount[] = []
  let assetTotal = 0
  let liabilityTotal = 0
  for (const a of accounts) {
    const balance = a.current_balance ?? 0
    const row: BreakdownAccount = {
      id: a.id,
      account_id: a.account_id,
      name: a.name ?? 'Account',
      subtype: a.subtype,
      balance,
      owed: isLiability(a.type),
    }
    if (isLiability(a.type)) {
      liabilities.push(row)
      liabilityTotal += balance
    } else if (ASSET_TYPES.has(a.type ?? '')) {
      assets.push(row)
      assetTotal += balance
    }
    // Unknown types are ignored, matching netWorth().
  }
  return { assets, liabilities, assetTotal, liabilityTotal, net: assetTotal - liabilityTotal }
}

// Category spend record -> rows sorted by amount, largest first.
export function sortedSpendRows(byCat: Record<string, number>): {
  category: string
  amount: number
}[] {
  return Object.entries(byCat)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount)
}
