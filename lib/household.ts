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
