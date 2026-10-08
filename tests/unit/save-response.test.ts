import { describe, it, expect } from 'vitest'
import { readSaveResponse, SESSION_ENDED, SAVE_FAILED } from '@/lib/save-response'

// #28 spec §8.2's rule, shared by the rules card: a save counts only when the reply is OK, not
// redirected, and JSON with ok: true.
const res = (o: { ok?: boolean; redirected?: boolean; json?: boolean; body?: unknown; bad?: boolean }) =>
  ({
    ok: o.ok ?? true,
    redirected: o.redirected ?? false,
    headers: new Headers(o.json === false ? { 'content-type': 'text/html' } : { 'content-type': 'application/json' }),
    json: async () => {
      if (o.bad) throw new SyntaxError('bad json')
      return o.body
    },
  }) as unknown as Response

describe('readSaveResponse', () => {
  it('accepts only a JSON ok: true', async () => {
    expect(await readSaveResponse(res({ body: { ok: true } }))).toEqual({ ok: true })
    expect(await readSaveResponse(res({ body: {} }))).toEqual({ ok: false, error: SAVE_FAILED })
  })
  it('reads a redirect, or an OK reply that is not JSON, as an ended session', async () => {
    expect(await readSaveResponse(res({ redirected: true, body: { ok: true } }))).toEqual({ ok: false, error: SESSION_ENDED })
    expect(await readSaveResponse(res({ json: false }))).toEqual({ ok: false, error: SESSION_ENDED })
  })
  it("shows the route's message on a refusal, and a fallback for a non-JSON failure", async () => {
    expect(await readSaveResponse(res({ ok: false, body: { error: 'This rule just changed. Refresh and try again.' } }))).toEqual({
      ok: false,
      error: 'This rule just changed. Refresh and try again.',
    })
    expect(await readSaveResponse(res({ ok: false, json: false }))).toEqual({ ok: false, error: SAVE_FAILED })
  })
  it("throws when the route's own OK reply cannot be read, because it may have saved", async () => {
    await expect(readSaveResponse(res({ bad: true }))).rejects.toThrow('bad json')
  })
})
