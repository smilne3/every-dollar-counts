// Whether a mutation's reply means it saved (#28 spec §8.2). A signed-out request is redirected to
// /login and fetch follows it to an HTML page: a 200 that saved nothing. So a save counts only
// when the reply is OK, not redirected, and JSON with ok: true. Mirrors CategoryPicker's inline
// handling, which predates this.
export const SAVE_FAILED = 'That could not be saved.'
export const SESSION_ENDED = 'Your session ended. Sign in again.'
// For a request that failed in flight, or whose OK reply could not be read: it may have reached the
// server and written, so "could not be saved" would be a guess. Callers show this and reload.
export const MAY_NOT_HAVE_SAVED = 'It may not have saved. Showing the latest.'

export type SaveResult = { ok: true } | { ok: false; error: string }

// Throws when the route's own OK JSON reply cannot be read: the outcome is unknown, and the caller
// treats it like a request lost in flight.
export async function readSaveResponse(res: Response): Promise<SaveResult> {
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json')
  if (res.redirected || (res.ok && !isJson)) return { ok: false, error: SESSION_ENDED }
  let body: { ok?: unknown; error?: unknown } | null = null
  if (isJson) {
    try {
      body = await res.json()
    } catch (err) {
      if (res.ok) throw err
    }
  }
  if (res.ok && body?.ok === true) return { ok: true }
  return { ok: false, error: typeof body?.error === 'string' ? body.error : SAVE_FAILED }
}
