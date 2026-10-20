// What the pages say about each linked bank. Pure, so the pages, the banner and lib/dashboard.ts's
// average can all use it without loading the service-role client that lib/plaid-items.ts reads with.

// A bank isn't syncing when its last sync failed in any way (`status` is 'ok' only after a good
// one; db/migrations/010_plaid_production.sql has the rest). Its figures stop where that sync left
// them. The one definition behind the "isn't syncing" banner and the hidden savings average (#135),
// so no two pages can disagree about which banks are behind.
export function notSyncing<T extends { status: string }>(items: T[]): T[] {
  return items.filter((i) => i.status !== 'ok')
}

// What to say about banks that are connected but have no accounts yet (#164). The exchange route
// keeps a bank whose first balance pull failed, and tells the person to press Refresh; until the
// balances arrive it has no accounts rows. Read as "no banks", that state invited linking the same
// bank again, which spends one of ten lifetime connections (#51). For one bank or more.
export function balancesPending(items: { institution_name: string | null }[]): string {
  return items.length === 1
    ? `${items[0].institution_name ?? 'Your bank'} is connected, but its balances haven't arrived yet.`
    : `${items.length} banks are connected, but their balances haven't arrived yet.`
}
