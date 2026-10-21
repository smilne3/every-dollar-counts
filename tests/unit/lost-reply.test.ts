import { describe, it, expect } from 'vitest'
import { replyWasLost, unknownIfLost } from '@/lib/lost-reply'
import { readSaveResponse } from '@/lib/save-response'
import { GATEWAY_502, GATEWAY_520, NO_ANSWER, REFUSED_5XX } from '../stubs/no-answer'
import { answerOf, UNKNOWN_ANSWER } from './helpers/route-answers'

// #173: every route that writes answers through this when the database's answer to a write was lost.
// Such a write may have committed, so the answer is "may not have saved", which sendSave and
// sendRequest read as an unknown outcome (tests/unit/save-response.test.ts), never the route's
// refusal, which tells the control nothing was written.
//
// Each case is shaped as postgrest-js reports it (checked against it: a fetch that rejects, the
// pages below, and PostgREST's own refusals).
const gateway = (status: number, message: string) => ({ status, error: { message } })
const refusal = (status: number, code: string) => ({ status, error: { code, message: 'refused' } })

describe('replyWasLost', () => {
  it.each([
    ['no reply at all', NO_ANSWER],
    ["the API gateway's 502 in PostgREST's place", GATEWAY_502],
    ["Cloudflare's 520: the origin answered something it could not read", GATEWAY_520],
    ["Cloudflare's 524: the origin took too long", gateway(524, '<html>A timeout occurred</html>')],
    ["the gateway's 504, in JSON but with no code", gateway(504, 'upstream request timeout')],
  ])('is true for %s, after which the write may have committed', (_, { status, error }) => {
    expect(replyWasLost(status, error)).toBe(true)
  })

  // A refusal carries PostgREST's or Postgres's code, whatever its status, and nothing was written.
  // A 4xx with no code came from in front of PostgREST, refusing the request before it went on.
  it.each([
    ['a duplicate, answered 409', refusal(409, '23505')],
    ['row-level security, answered 403', refusal(403, '42501')],
    ['.single() with no row, answered 406', refusal(406, 'PGRST116')],
    ['a statement timeout, answered 500', REFUSED_5XX],
    ['PostgREST out of database connections, answered 503', refusal(503, 'PGRST003')],
    ['a bad API key at the gateway, answered 401 with no code', gateway(401, 'Invalid API key')],
  ])('is false for %s', (_, { status, error }) => {
    expect(replyWasLost(status, error)).toBe(false)
  })

  // A code is PostgREST's or Postgres's only if it is words: an empty one is postgrest-js's own, for
  // no reply, and anything else came from in front of PostgREST.
  it('is true for a 5xx whose code is empty, or not a string', () => {
    expect(replyWasLost(502, { code: '', message: 'Bad Gateway' })).toBe(true)
    expect(replyWasLost(502, { code: 502, message: 'Bad Gateway' })).toBe(true)
  })
})

describe('unknownIfLost', () => {
  it.each([
    ['no reply at all', NO_ANSWER],
    ["a gateway's 502", GATEWAY_502],
    ["Cloudflare's 520", GATEWAY_520],
  ])('answers a 502 in plain text, not JSON, for %s', async (_, { status, error }) => {
    expect(await answerOf(unknownIfLost(status, error)!)).toEqual(UNKNOWN_ANSWER)
  })

  // Not JSON, so a page loaded before this shipped reads it as unknown too: readSaveResponse treats
  // a failure that is not the route's JSON as one it cannot read, as it did before #173.
  it('is a reply readSaveResponse cannot read, so it is never taken for a refusal', async () => {
    await expect(readSaveResponse(unknownIfLost(NO_ANSWER.status, NO_ANSWER.error)!)).rejects.toThrow('unreadable 502 reply')
  })

  it.each([
    ['a refusal with a code, answered 409', refusal(409, '23505')],
    ['a refusal with a code, answered 500', REFUSED_5XX],
    ['a refusal with a code, answered 503', refusal(503, 'PGRST003')],
  ])('leaves the answer to the route for %s', (_, { status, error }) => {
    expect(unknownIfLost(status, error)).toBeNull()
  })
})
