import { describe, it, expect } from 'vitest'
import { unknownIfLost } from '@/lib/lost-reply'
import { MAY_NOT_HAVE_SAVED } from '@/lib/save-response'
import { NO_ANSWER } from '../stubs/no-answer'

// #173: every route that writes answers through this when postgrest-js says the database never
// answered a write. Such a write may have committed, so the answer is "may not have saved", which
// sendSave and sendRequest read as an unknown outcome (tests/unit/save-response.test.ts), never the
// route's refusal, which tells the control nothing was written.
describe('unknownIfLost', () => {
  it('answers 502, in words, with the mark the browser reads as unknown, for a write with no reply', async () => {
    const res = unknownIfLost(NO_ANSWER.status)
    expect(res?.status).toBe(502)
    expect(res?.headers.get('content-type')).toContain('application/json')
    expect(await res?.json()).toEqual({ error: MAY_NOT_HAVE_SAVED, unknown: true })
  })

  // A refusal comes back with an HTTP status, and from PostgREST or Postgres with a code: nothing
  // was written, and the route's own answer stands. Among them PostgREST's 406 for .single() with no
  // row, and its 503 when it cannot reach Postgres.
  it.each([400, 401, 403, 404, 406, 409, 500, 503])('leaves the answer to the route for a refusal with status %i', (status) => {
    expect(unknownIfLost(status)).toBeNull()
  })
})
