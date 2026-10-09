// Category rules (#28): turning a transaction into a category NAME. Pure, no I/O.
//
// resolveCategory is the ONLY code that does this (card payments display their pick or 'Card
// payment' directly). Every page, count and filter goes through it, so precedence (a hand pick,
// then the merchant's rule, then the bank's category), the card-payment exemption and the kind
// gate live in one place. A rule's effect exists only here, at read time:
// nothing is written to transactions, so changing or removing a rule moves every row with it.
import {
  isCardPaymentRow,
  nonSpendingNames,
  pfcToName,
  transferNames,
  TRANSFER_PFC,
  type Category,
} from './categories'

// All four REQUIRED, so a page whose select drops one fails tsc instead of resolving wrongly.
export type CategorizableTxn = {
  user_category: string | null
  pfc_primary: string | null
  pfc_detailed: string | null
  merchant_name: string | null
}

export type CategoryRule = {
  id: string
  household_id: string
  merchant_key: string
  merchant_label: string
  category_id: string
  origin: 'seeded' | 'learned'
}

export type Kind = 'spending' | 'transfer' | 'income'

// Keyed on `source`, so only a rule can carry a ruleId. bankName is what the bank mapping alone
// would show.
export type ResolvedCategory = Readonly<
  | { source: 'pick'; name: string; ruleId: null; bankName: string }
  | { source: 'rule'; name: string; ruleId: string; bankName: string }
  | { source: 'bank'; name: string; ruleId: null; bankName: string }
>

// Brands. A page that forgets the rules must not compile: CategoryData comes only from
// fetchCategoryContext (lib/category-context.ts), and the two contexts only from the builders
// below. A hand-built `{ categories, rules: [] }` lacks the brand and fails tsc. The state lives
// under non-exported symbol keys (not a WeakMap or #private) so buildSpendContext can spread a
// context. Tripwire 4 (scripts/check-invariants.mjs) rejects `as CategoryData` and friends outside
// this file, lib/category-context.ts and lib/spend-context.ts. The brand stops a page that never
// touched the rules; spreading CategoryData keeps the brand, so it does not stop a page that
// deliberately edits the rules list.
declare const DATA_BRAND: unique symbol
const KIND_STATE = Symbol('kind-context')
const RULE_STATE = Symbol('category-context')

export type CategoryData = {
  readonly categories: Category[]
  readonly rules: CategoryRule[]
  readonly [DATA_BRAND]: true
}

type KindState = {
  pfcMap: Record<string, string> // Plaid primary -> category name (last wins, as pfcToName)
  transfers: Set<string> // the exact sets the totals branch on
  nonSpending: Set<string>
}
type RuleState = {
  byKey: Map<string, CategoryRule>
  nameById: Map<string, string>
}

export type KindContext = { readonly [KIND_STATE]: KindState }
export type CategoryContext = KindContext & { readonly [RULE_STATE]: RuleState }

// null for null, '' or whitespace; otherwise trimmed and lowercased. Matches the seed's
// `lower(regexp_replace(merchant_name, '^\s+|\s+$', '', 'g'))` — not `lower(trim())`: on ASCII, JS
// trim() and Postgres `\s` strip the same six whitespace characters. Launch check 3a confirms every
// merchant name is ASCII when the seed runs.
export function merchantKey(s: string | null): string | null {
  const k = (s ?? '').trim().toLowerCase()
  return k || null
}

export function buildKindContext(categories: Category[]): KindContext {
  return {
    [KIND_STATE]: {
      pfcMap: pfcToName(categories),
      transfers: transferNames(categories),
      nonSpending: nonSpendingNames(categories),
    },
  }
}

// `withoutCategoryId` builds the context as if that category, and every rule pointing at it, were
// already deleted: deleteImpact (lib/category-views.ts) uses it to say what a delete would move.
export function buildCategoryContext(
  data: CategoryData,
  opts: { withoutCategoryId?: string } = {}
): CategoryContext {
  // The app assumes one household per user (memberships are read with `.limit(1)`). Make that fail
  // loudly for rules rather than silently applying another household's.
  if (new Set(data.rules.map((r) => r.household_id)).size > 1) {
    throw new Error('category rules span more than one household')
  }
  const gone = opts.withoutCategoryId
  const categories = gone ? data.categories.filter((c) => c.id !== gone) : data.categories
  const rules = gone ? data.rules.filter((r) => r.category_id !== gone) : data.rules
  const byKey = new Map<string, CategoryRule>()
  for (const r of rules) byKey.set(r.merchant_key, r)
  return {
    ...buildKindContext(categories),
    [RULE_STATE]: { byKey, nameById: new Map(categories.map((c) => [c.id, c.name])) },
  }
}

// How the totals count a category name. Transfers first, because the non-spending set contains
// them. Any name no category holds is in neither, so it counts as spending. So does
// 'Uncategorized', unless a household category of that name maps to an income or transfer primary
// (a renamed default).
export function kindOf(name: string, k: KindContext): Kind {
  const s = k[KIND_STATE]
  if (s.transfers.has(name)) return 'transfer'
  if (s.nonSpending.has(name)) return 'income'
  return 'spending'
}

function plaidKind(pfcPrimary: string | null): Kind {
  if (pfcPrimary && TRANSFER_PFC.has(pfcPrimary)) return 'transfer'
  if (pfcPrimary === 'INCOME') return 'income'
  return 'spending'
}

// The category the bank's tag maps to, and its kind. When the primary maps to no household
// category (its default was deleted, or Plaid sent one with no default), the row SHOWS as
// 'Uncategorized' but its kind comes from Plaid's own tag, so the two can differ; see resolveCategory.
function bankCategory(t: { pfc_primary: string | null }, k: KindContext): { name: string; kind: Kind } {
  const mapped = t.pfc_primary ? k[KIND_STATE].pfcMap[t.pfc_primary] : undefined
  if (mapped) return { name: mapped, kind: kindOf(mapped, k) }
  return { name: 'Uncategorized', kind: plaidKind(t.pfc_primary) }
}

export function resolveCategory(t: CategorizableTxn, ctx: CategoryContext): ResolvedCategory {
  const bank = bankCategory(t, ctx)
  const asBank: ResolvedCategory = { name: bank.name, source: 'bank', ruleId: null, bankName: bank.name }
  // 1. A hand pick wins, even on a card payment (the existing "user override wins" contract).
  if (t.user_category) return { name: t.user_category, source: 'pick', ruleId: null, bankName: bank.name }
  // 2. Card payments never take a rule: any category on one re-enters it into every total (#59).
  //    pfc_detailed alone, never isCreditCardPayment.
  if (isCardPaymentRow(t.pfc_detailed)) return asBank
  // 3. The merchant's rule, only within one kind. The rule's kind must equal BOTH Plaid's kind for
  //    the row and the kind of the name the totals would otherwise count it under. For a mapped
  //    row those agree; for an unmapped one they can differ, and the row then takes no rule and
  //    stays counted exactly as it is today. So no set of rules moves Spent, Income or Saved.
  const key = merchantKey(t.merchant_name)
  const rule = key ? ctx[RULE_STATE].byKey.get(key) : undefined
  const name = rule ? ctx[RULE_STATE].nameById.get(rule.category_id) : undefined
  if (rule && name) {
    const kind = kindOf(name, ctx)
    if (kind === bank.kind && kind === kindOf(bank.name, ctx)) {
      return { name, source: 'rule', ruleId: rule.id, bankName: bank.name }
    }
  }
  return asBank
}

// A rule that relabelled the row, as opposed to one that agrees with the bank. Drives the learned
// marker and the Settings counts.
export function changedByRule(r: ResolvedCategory): boolean {
  return r.source === 'rule' && r.name !== r.bankName
}
