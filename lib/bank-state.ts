// What the pages say about each linked bank. Pure, so the pages, the banner and lib/dashboard.ts's
// average can all use it without loading the service-role client that lib/plaid-items.ts reads with.

// A bank isn't syncing when its last sync failed in any way (`status` is 'ok' only after a good
// one; db/migrations/010_plaid_production.sql has the rest). Its figures stop where that sync left
// them. The one definition behind the "isn't syncing" banner and the hidden savings average (#135),
// so no two pages can disagree about which banks are behind.
export function notSyncing<T extends { status: string }>(items: T[]): T[] {
  return items.filter((i) => i.status !== 'ok')
}
