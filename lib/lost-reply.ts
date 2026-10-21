import 'server-only'
import { NextResponse } from 'next/server'
import { MAY_NOT_HAVE_SAVED } from '@/lib/save-response'

// Whether the database's answer to a write was lost, so the write may have committed (#173):
// - status 0: postgrest-js got no reply at all. It retries a GET, HEAD or OPTIONS, never a POST,
//   PATCH or DELETE, so a write whose request failed in flight, or whose reply was cut off, comes
//   back once as { error: { message: 'TypeError: fetch failed', code: '' }, status: 0 }. The
//   connection can drop after Supabase had the write.
// - a 5xx with no code: a gateway answered in PostgREST's place, with Cloudflare's 520 or 524, say,
//   or the API gateway's 502 or 504, and the write may have reached the database before it did.
// A refusal from PostgREST or Postgres always carries a code, whatever its status, and nothing of
// it was written, so it stays the route's own answer. Reads never come here: a read that failed
// wrote nothing, so trying it again is safe.
type WriteError = { code?: unknown; message: string } | null

export function replyWasLost(status: number, error: WriteError): boolean {
  const coded = typeof error?.code === 'string' && error.code !== ''
  return status === 0 || (status >= 500 && !coded)
}

// The answer to a write whose reply was lost, or null for any other, so a route answers its refusal
// as before:
//   return unknownIfLost(status, error) ?? fail(500, TRY_AGAIN)
//
// Answered as a refusal, a write's control keeps what was typed for another try, and another Add
// makes a second goal, since goal names are not unique. So the route answers a 502 that is not JSON
// instead. Every client reads a 5xx that is not the route's JSON as an unknown outcome
// (readSaveResponse and sendRequest, lib/save-response.ts), a page loaded before this shipped among
// them: the control says, in its own words, that it may not have saved, and reloads to show what
// landed. 502, because the route stands in front of the database and had no answer from it: not
// 500, which these routes give for a refusal, nor 503, which they give when Supabase Auth is
// unreachable and nothing was written. The text is for the log and the network panel.
export function unknownIfLost(status: number, error: WriteError): NextResponse | null {
  if (!replyWasLost(status, error)) return null
  return new NextResponse(MAY_NOT_HAVE_SAVED, { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
