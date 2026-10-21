// Whether a mutation's reply means it saved (#28 spec §8.2). A signed-out request is redirected to
// /login and fetch follows it to an HTML page: a 200 that saved nothing. So a save counts only
// when the reply is OK, not redirected, and JSON with ok: true. The category, budget, reimbursable,
// goal, home value, time zone, invite and Disconnect controls send their saves through sendSave
// below, and Refresh and the Plaid Link requests go through sendRequest, its counterpart for replies
// that carry data, so for all of them the rule lives in one place (#145, #165).
export const SAVE_FAILED = 'That could not be saved.'
export const SESSION_ENDED = 'Your session ended. Sign in again.'
// For a request that failed in flight, or whose reply could not be read: it may have reached the
// server and written, so "could not be saved" would be a guess. Callers show this and reload.
export const MAY_NOT_HAVE_SAVED = 'It may not have saved. Showing the latest.'

// `status` lets a caller tell a stale-card refusal (404, 409) from the rest. `savedAt`, from a route
// that sends it, is when the write was done by the server's clock, so a caller can tell a reload
// that read before the write from one that read after (#176).
export type SaveResult = { ok: true; savedAt?: number } | { ok: false; error: string; status: number }

// Throws when the reply cannot be read: an OK JSON reply that does not parse, or a failure that is
// not the route's own JSON (a 502, a 504, an HTML 500), which can come after the write committed.
// Throws too when the route says it cannot tell (`unknown: true`, lib/lost-reply.ts): the database
// never answered its write, which may have committed (#173). The outcome is unknown, and the caller
// treats it like a request lost in flight.
export async function readSaveResponse(res: Response): Promise<SaveResult> {
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json')
  if (res.redirected || (res.ok && !isJson)) return { ok: false, error: SESSION_ENDED, status: res.status }
  if (!isJson) throw new Error(`unreadable ${res.status} reply`)
  const body: { ok?: unknown; error?: unknown; savedAt?: unknown; unknown?: unknown } | null = await res.json()
  if (res.ok && body?.ok === true) return { ok: true, savedAt: typeof body.savedAt === 'number' ? body.savedAt : undefined }
  if (body?.unknown === true) throw new Error(`${res.status} reply: the database did not answer the write`)
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

// 'unknown': the request failed in flight, timed out, got a reply that could not be read, or got the
// route's word that the database never answered its write. It may have written, so the caller shows
// MAY_NOT_HAVE_SAVED and reloads. `cause` is for the log.
export type SaveOutcome =
  | { outcome: 'saved'; savedAt?: number }
  | { outcome: 'refused'; error: string; status: number }
  | { outcome: 'unknown'; cause: unknown }

// Sends a save and reports what happened. Never throws. The timeout covers reading the reply too:
// fetch aborts the body when its signal fires.
export async function sendSave(url: string, init: RequestInit): Promise<SaveOutcome> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) })
    const result = await readSaveResponse(res)
    return result.ok ? { outcome: 'saved', savedAt: result.savedAt } : { outcome: 'refused', error: result.error, status: result.status }
  } catch (cause) {
    return { outcome: 'unknown', cause }
  }
}

// For a request whose reply carries data rather than a bare save: a link token, a sync's counts, a
// linked bank's warning (#165). The rules are sendSave's. A redirect, or an OK reply that is not
// JSON, is the login page, so the session ended. A reply that cannot be read may have come after the
// work was done, so it is 'unknown', and so is the route's own word that the database never answered
// one of its writes (#173). A failure is a refusal only when it is the route's own { error } in
// words, as every refusal those routes give is; anything else came from in front of the route.
// 'answered' hands back the route's JSON object for the caller to check. The timeout is the caller's,
// because how long a route may run, and whether giving up early is harmless, differ by route.
export type RequestOutcome =
  | { outcome: 'answered'; body: Record<string, unknown> }
  | { outcome: 'refused'; error: string; status: number }
  | { outcome: 'unknown'; cause: unknown }

// Never throws. The timeout covers reading the reply too, as sendSave's does.
export async function sendRequest(url: string, init: RequestInit, timeoutMs: number): Promise<RequestOutcome> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json')
    if (res.redirected || (res.ok && !isJson)) return { outcome: 'refused', error: SESSION_ENDED, status: res.status }
    const body: unknown = isJson ? await res.json() : null
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error(`unreadable ${res.status} reply`)
    const fields = body as Record<string, unknown>
    if (res.ok) return { outcome: 'answered', body: fields }
    if (fields.unknown === true) throw new Error(`${res.status} reply: the database did not answer the write`)
    if (typeof fields.error === 'string') return { outcome: 'refused', error: fields.error, status: res.status }
    throw new Error(`unreadable ${res.status} reply`)
  } catch (cause) {
    return { outcome: 'unknown', cause }
  }
}
