// A transaction's effective category NAME: the user's override if set, otherwise
// the household category mapped from Plaid's PFC primary, else 'Uncategorized'.
export function effectiveCategory(
  t: { user_category: string | null; pfc_primary: string | null },
  pfcToName: Record<string, string>
): string {
  if (t.user_category) return t.user_category
  if (t.pfc_primary && pfcToName[t.pfc_primary]) return pfcToName[t.pfc_primary]
  return 'Uncategorized'
}
