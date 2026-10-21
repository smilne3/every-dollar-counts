import 'server-only'
import { NextResponse } from 'next/server'
import { MAY_NOT_HAVE_SAVED } from '@/lib/save-response'

// A write the database never answered (#173). postgrest-js retries a GET, HEAD or OPTIONS, never a
// POST, PATCH or DELETE, so a write whose request fails in flight comes back once, as
// { error: { message: 'TypeError: fetch failed', code: '' }, status: 0 }: no HTTP reply at all. The
// connection can drop after Supabase had the write, so it may have committed. A refusal comes back
// with a status, and from PostgREST or Postgres with a code, and stays the route's own answer. Reads
// never come here: a read that failed wrote nothing, so trying it again is safe.
//
// Answered as a refusal, a write's control keeps what was typed for another try, and another Add
// makes a second goal, since goal names are not unique. So the route answers a 502 that is not JSON
// instead. Every client reads a 5xx that is not the route's JSON as an unknown outcome
// (readSaveResponse and sendRequest, lib/save-response.ts), a page loaded before this shipped among
// them: the control says, in its own words, that it may not have saved, and reloads to show what
// landed. 502, because the route stands in front of the database and had no answer from it: not
// 500, which these routes give for a refusal, nor 503, which they give when Supabase Auth is
// unreachable and nothing was written. The text is for the log and the network panel.
//
// Returns null for any other status, so a route answers its refusal as before:
//   return unknownIfLost(status) ?? fail(500, TRY_AGAIN)
export function unknownIfLost(status: number): NextResponse | null {
  if (status !== 0) return null
  return new NextResponse(MAY_NOT_HAVE_SAVED, { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
