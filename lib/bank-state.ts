// What the pages say about each linked bank. Pure, so the pages, the banner and lib/dashboard.ts's
// average can all use it without loading the service-role client that lib/plaid-items.ts reads with.

// A bank isn't syncing when its last sync failed in any way (`status` is 'ok' only after a good
// one; db/migrations/010_plaid_production.sql has the rest). Its figures stop where that sync left
// them. The one definition behind the "isn't syncing" banner and the hidden savings average (#135),
// so no two pages can disagree about which banks are behind.
export function notSyncing<T extends { status: string }>(items: T[]): T[] {
  return items.filter((i) => i.status !== 'ok')
}

// Banks with no accounts yet, split by what Refresh can do for them (#186), for the three places that
// word them: the #164 dashboard card, components/MissingBalancesNote.tsx and the Settings first line.
// - `syncing`: Refresh can bring in their balances and transactions. They are syncing, or the bank
//   only didn't respond last time (temporarily_unavailable), which Refresh simply retries
//   (lib/sync-policy.ts).
// - `behind`: Refresh can't. It skips a bank whose login broke, and one that needs something done at
//   the bank or to its setup fails again the same way. Settings says what each one needs. So does a
//   status this code has never seen: it is promised nothing.
// notSyncing() stays the definition for the banner and the average (#135). They ask something else:
// whether a bank's figures are current, and a bank that didn't respond last time is behind on them.
export function bySync<T extends { status: string }>(items: T[]): { syncing: T[]; behind: T[] } {
  const fetchable = (i: T) => i.status === 'ok' || i.status === 'temporarily_unavailable'
  return { syncing: items.filter(fetchable), behind: items.filter((i) => !fetchable(i)) }
}

// The banks with no accounts yet (#170): connected, but their first balance pull failed (#164), so
// none of their balances are in, and none of their transactions, which each need their account's
// row (db/migrations/010_plaid_production.sql). Net worth, cash on hand and every spending figure
// leave these banks out, however many other banks have accounts. By the accounts' own
// plaid_item_id, so a bank counts as arrived with any account at all: one with only a mortgage has
// its balance in.
export function withoutAccounts<T extends { id: string }>(items: T[], accounts: { plaid_item_id: string }[]): T[] {
  const arrived = new Set(accounts.map((a) => a.plaid_item_id))
  return items.filter((i) => !arrived.has(i.id))
}

// What to say about banks that are connected but have no accounts yet (#164). The exchange route
// keeps a bank whose first balance pull failed, and tells the person to press Refresh; until the
// balances arrive it has no accounts rows, and so no transactions either (#170). Read as "no
// banks", that state invited linking the same bank again, which spends one of ten lifetime
// connections (#51). Only for banks whose balances Refresh can pull (bySync). One whose bank didn't
// respond last time is told so, briefly, so the wait has a reason (#186). Not one whose sync failed
// on this app's own side (APP_ERROR, #189): that wasn't the bank. For one bank or more.
export function balancesPending(
  items: { institution_name: string | null; status: string; status_detail: string | null }[]
): string {
  const quiet = items.filter((i) => i.status === 'temporarily_unavailable' && i.status_detail !== 'APP_ERROR')
  if (items.length === 1) {
    const why = quiet.length ? " It didn't respond last time." : ''
    return `${items[0].institution_name ?? 'Your bank'} is connected, but its balances and transactions haven't arrived yet.${why}`
  }
  const why =
    quiet.length === 0
      ? ''
      : quiet.length === items.length
        ? " They didn't respond last time."
        : quiet.length === 1
          ? ` ${quiet[0].institution_name ?? 'One of them'} didn't respond last time.`
          : ` ${quiet.length} of them didn't respond last time.`
  return `${items.length} banks are connected, but their balances and transactions haven't arrived yet.${why}`
}

// The same for banks with no accounts that Refresh can't help (bySync), and it promises nothing.
// Refresh skips a bank whose login broke, and one that needs something done at the bank or to its
// setup fails again, so their balances are not on their way; Settings says what each one needs.
// `inSettings` says where, for a page other than Settings.
export function balancesBlocked(items: { institution_name: string | null }[], { inSettings = false } = {}): string {
  const where = inSettings ? ' in Settings' : ''
  return items.length === 1
    ? `${items[0].institution_name ?? 'Your bank'} is connected, but its balances and transactions can't arrive until it's sorted out${where}.`
    : `${items.length} banks are connected, but their balances and transactions can't arrive until they're sorted out${where}.`
}
