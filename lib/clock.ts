// The household's wall clock, and the ONLY module in the app that turns a real instant into a
// calendar value. Everything below this boundary takes a 'YYYY-MM-DD' string.
//
// This exists because `new Date()` on the server is UTC on Vercel while the household is in US
// Eastern, so for about 18% of the year — every evening from 8pm until local midnight — the
// server's calendar day is not the household's (#73).

// `now` is injectable so behaviour can be pinned at a fixed instant in tests. Production omits it.

function formatterFor(timeZone: string, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone })
  } catch {
    // Falling back to UTC here would be this whole bug wearing a different hat: a wrong day,
    // rendered confidently, with nothing to indicate it.
    throw new Error(`unknown time zone: ${timeZone}`)
  }
}

// The calendar day in `timeZone`, as 'YYYY-MM-DD'.
//
// Read out of formatToParts rather than by parsing a formatted string — locale part ordering is
// not a contract, and 'en-US' would otherwise hand back 9/2/2026.
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = formatterFor(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

// The hour of day in `timeZone`, 0-23.
export function hourIn(timeZone: string, now: Date = new Date()): number {
  const parts = formatterFor(timeZone, { hour: '2-digit', hour12: false }).formatToParts(now)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  // Some implementations render midnight as 24 under hour12: false, which would read as evening.
  return hour % 24
}

// Whether Intl recognises this zone. The only authoritative validator available — Postgres cannot
// check an IANA name from a column constraint, so this guards the write instead.
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}
