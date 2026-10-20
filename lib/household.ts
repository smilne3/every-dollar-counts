import { cache } from 'react'
import { createClient } from './supabase/server'

// The zone this household is assumed to be in until it says otherwise. Matches the column default
// in db/migrations/019_household_timezone.sql — change both together.
export const DEFAULT_TIMEZONE = 'America/New_York'

// The household's timezone, for the four pages that need to know what day it is.
//
// Wrapped in React's cache() so a page reading it more than once during a single render costs one
// query. Before #73 the households row was read in only two places and never by a money page;
// four now need it, which is why this exists rather than another inline select.
export const householdTimezone = cache(async (): Promise<string> => {
  const supabase = await createClient()
  const { data, error } = await supabase.from('households').select('timezone').limit(1).maybeSingle()
  // A failed read must not quietly become the default: the default decides which month the tiles
  // report, so guessing here would produce a confident wrong number (#46).
  if (error) throw new Error(`could not read the household timezone: ${error.message}`)
  // No row, or a null column, is a different thing from a failure — a household that has not set
  // one yet. The default is the honest answer.
  return (data?.timezone as string | null | undefined) ?? DEFAULT_TIMEZONE
})

// The signed-in person's household id, for the reads the service-role client makes on a page's
// behalf (lib/plaid-items.ts), which RLS does not scope. Throws on a failed read: without the
// household a page cannot ask which banks are syncing, and an empty answer would hide the "isn't
// syncing" banner (#46, #135).
//
// Null for an account with no membership, which sign-in lets through when it cannot check
// (lib/access.ts fails open). That account has no household and so no banks, which is the truth,
// not a failed read. maybeSingle, not single: single makes no row an error (PGRST116), which put
// such an account on the error page on every visit, with nothing a retry could fix.
export async function currentHouseholdId(): Promise<string | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.from('memberships').select('household_id').limit(1).maybeSingle()
  if (error) {
    const code = error.code ? `${error.code} ` : ''
    throw new Error(`could not read your household: ${code}${error.message}`)
  }
  return (data?.household_id as string | undefined) ?? null
}
