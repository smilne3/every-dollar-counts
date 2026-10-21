import { describe, it, expect } from 'vitest'
import { unknownIfLost } from '@/lib/lost-reply'
import { readSaveResponse } from '@/lib/save-response'
import { NO_ANSWER } from '../stubs/no-answer'
import { answerOf, UNKNOWN_ANSWER } from './helpers/route-answers'

// #173: every route that writes answers through this when postgrest-js says the database never
// answered a write. Such a write may have committed, so the answer is "may not have saved", which
// sendSave and sendRequest read as an unknown outcome (tests/unit/save-response.test.ts), never the
// route's refusal, which tells the control nothing was written.
describe('unknownIfLost', () => {
  it('answers a 502 in plain text, not JSON, for a write with no reply', async () => {
    expect(await answerOf(unknownIfLost(NO_ANSWER.status)!)).toEqual(UNKNOWN_ANSWER)
  })

  // Not JSON, so a page loaded before this shipped reads it as unknown too: readSaveResponse treats
  // a failure that is not the route's JSON as one it cannot read, as it did before #173.
  it('is a reply readSaveResponse cannot read, so it is never taken for a refusal', async () => {
    await expect(readSaveResponse(unknownIfLost(NO_ANSWER.status)!)).rejects.toThrow('unreadable 502 reply')
  })

  // A refusal comes back with an HTTP status, and from PostgREST or Postgres with a code: nothing
  // was written, and the route's own answer stands. Among them PostgREST's 406 for .single() with no
  // row, and its 503 when it cannot reach Postgres.
  it.each([400, 401, 403, 404, 406, 409, 500, 503])('leaves the answer to the route for a refusal with status %i', (status) => {
    expect(unknownIfLost(status)).toBeNull()
  })
})
