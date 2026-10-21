// What the pages say about each linked bank. Pure, so the pages, the banner and lib/dashboard.ts's
// average can all use it without loading the service-role client that lib/plaid-items.ts reads with.

// A bank isn't syncing when its last sync failed in any way (`status` is 'ok' only after a good
// one; db/migrations/010_plaid_production.sql has the rest). Its figures stop where that sync left
// them. The one definition behind the "isn't syncing" banner and the hidden savings average (#135),
// so no two pages can disagree about which banks are behind.
export function notSyncing<T extends { status: string }>(items: T[]): T[] {
  return items.filter((i) => i.status !== 'ok')
}

// The banks split by notSyncing(), so no split can use a second definition: those still syncing,
// and those behind.
export function bySync<T extends { status: string }>(items: T[]): { syncing: T[]; behind: T[] } {
  const behind = notSyncing(items)
  return { syncing: items.filter((i) => !behind.includes(i)), behind }
}

// The banks with no accounts yet (#170): connected, but their first balance pull failed (#164), so
// none of their balances are in. Net worth and cash on hand are sums over accounts, so they leave
// these banks out, however many other banks have accounts. By the accounts' own plaid_item_id, so a
// bank counts as arrived with any account at all: one with only a mortgage has its balance in.
export function withoutAccounts<T extends { id: string }>(items: T[], accounts: { plaid_item_id: string }[]): T[] {
  const arrived = new Set(accounts.map((a) => a.plaid_item_id))
  return items.filter((i) => !arrived.has(i.id))
}

// What to say about banks that are connected but have no accounts yet (#164). The exchange route
// keeps a bank whose first balance pull failed, and tells the person to press Refresh; until the
// balances arrive it has no accounts rows. Read as "no banks", that state invited linking the same
// bank again, which spends one of ten lifetime connections (#51). Only for banks that are syncing
// (bySync), whose balances Refresh pulls. For one bank or more.
export function balancesPending(items: { institution_name: string | null }[]): string {
  return items.length === 1
    ? `${items[0].institution_name ?? 'Your bank'} is connected, but its balances haven't arrived yet.`
    : `${items.length} banks are connected, but their balances haven't arrived yet.`
}

// The same for banks with no accounts that aren't syncing, and it promises nothing. Refresh skips a
// bank whose login broke, and retries the rest without fixing what stopped them, so their balances
// are not on their way; Settings says what each one needs. `inSettings` says where, for a page
// other than Settings.
export function balancesBlocked(items: { institution_name: string | null }[], { inSettings = false } = {}): string {
  const where = inSettings ? ' in Settings' : ''
  return items.length === 1
    ? `${items[0].institution_name ?? 'Your bank'} is connected, but its balances can't arrive until it's sorted out${where}.`
    : `${items.length} banks are connected, but their balances can't arrive until they're sorted out${where}.`
}
