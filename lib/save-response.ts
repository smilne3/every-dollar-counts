// Whether a mutation's reply means it saved (#28 spec §8.2). A signed-out request is redirected to
// /login and fetch follows it to an HTML page: a 200 that saved nothing. So a save counts only
// when the reply is OK, not redirected, and JSON with ok: true. Every editor sends its saves through
// sendSave below, so this rule lives in one place (#145).
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

// How long a save may take before it counts as lost in flight (#103). Without a bound, a request on
// a dead connection keeps its editor busy, and the phone sheet that will not close over a save in
// flight shut, until the browser gives up on its own, which can take minutes. A save here is a few
// small database round trips: under a second normally, a few seconds on a weak phone signal or a
// cold server. 20 seconds is well past that and still short enough to wait out. Ending a slow save
// early cannot misreport it: it becomes "may not have saved", and the caller reloads to show what
// the server has.
export const SAVE_TIMEOUT_MS = 20_000

// 'unknown': the request failed in flight, timed out, or got a reply that could not be read. It may
// have written, so the caller shows MAY_NOT_HAVE_SAVED and reloads. `cause` is for the log.
export type SaveOutcome =
  | { outcome: 'saved' }
  | { outcome: 'refused'; error: string; status: number }
  | { outcome: 'unknown'; cause: unknown }

// Sends a save and reports what happened. Never throws. The timeout covers reading the reply too:
// fetch aborts the body when its signal fires.
export async function sendSave(url: string, init: RequestInit): Promise<SaveOutcome> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) })
    const result = await readSaveResponse(res)
    return result.ok ? { outcome: 'saved' } : { outcome: 'refused', error: result.error, status: result.status }
  } catch (cause) {
    return { outcome: 'unknown', cause }
  }
}
