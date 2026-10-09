// Whether a mutation's reply means it saved (#28 spec §8.2). A signed-out request is redirected to
// /login and fetch follows it to an HTML page: a 200 that saved nothing. So a save counts only
// when the reply is OK, not redirected, and JSON with ok: true. Mirrors CategoryPicker's inline
// handling, which predates this.
export const SAVE_FAILED = 'That could not be saved.'
export const SESSION_ENDED = 'Your session ended. Sign in again.'
// For a request that failed in flight, or whose reply could not be read: it may have reached the
// server and written, so "could not be saved" would be a guess. Callers show this and reload.
export const MAY_NOT_HAVE_SAVED = 'It may not have saved. Showing the latest.'

// `status` lets a caller tell a stale-card refusal (404, 409) from the rest.
export type SaveResult = { ok: true } | { ok: false; error: string; status: number }

// Throws when the reply cannot be read: an OK JSON reply that does not parse, or a failure that is
// not the route's own JSON (a 502, a 504, an HTML 500), which can come after the write committed.
// The outcome is unknown, and the caller treats it like a request lost in flight.
export async function readSaveResponse(res: Response): Promise<SaveResult> {
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json')
  if (res.redirected || (res.ok && !isJson)) return { ok: false, error: SESSION_ENDED, status: res.status }
  if (!isJson) throw new Error(`unreadable ${res.status} reply`)
  const body: { ok?: unknown; error?: unknown } | null = await res.json()
  if (res.ok && body?.ok === true) return { ok: true }
  return { ok: false, error: typeof body?.error === 'string' ? body.error : SAVE_FAILED, status: res.status }
}
