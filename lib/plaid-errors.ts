// Classifying WHY a bank stopped working, so the app can tell the user the one true next step.
//
// This matters more than it looks. Telling someone to "reconnect" a bank that is merely offline
// invites a disconnect-and-relink, which spends one of ten unrefundable Plaid Item slots and fixes
// nothing. Telling someone to "wait" for a bank that has locked their account means waiting
// forever. Every category below maps to a different sentence on screen.
//
// All code lists are taken from Plaid's live error reference, not from memory:
//   https://plaid.com/docs/errors/item/ · /errors/institution/ · /errors/rate-limit-exceeded/
//   /errors/invalid-input/ · /errors/api/

export type PlaidErrorCategory =
  // The login is broken; Link's UPDATE MODE fixes it. Show a Reconnect button. Costs no slot.
  | 'reconnect'
  // The user must do something at the bank's own website first. A Reconnect button here is a
  // trap: it will just fail again, and the natural next move is a relink that spends a slot.
  | 'action_at_bank'
  // Not the user's fault and not fixable by them. Show "nothing to do", retry later.
  | 'temporary'
  // The app or its configuration is wrong, not the bank. Never show this as "try again later" —
  // it will never come right on its own, and it needs the operator, not the user.
  | 'config'

// Fixed by sending the user back through Link in update mode.
const RECONNECT_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'ACCESS_NOT_GRANTED',
  'INVALID_UPDATED_USERNAME',
  'MANUAL_VERIFICATION_REQUIRED',
  'USER_PERMISSION_REVOKED',
  'USER_ACCOUNT_REVOKED',
])

// Plaid's remedy for each of these is an action at the institution, NOT update mode:
//   ITEM_LOCKED             "the user's account is locked" — unlock it with the bank
//   PASSWORD_RESET_REQUIRED "must log in directly to the financial institution and reset"
//   USER_SETUP_REQUIRED     "must log in directly ... and take some action"
//   INSUFFICIENT_CREDENTIALS user abandoned the OAuth flow — start Link again, don't wait
//   ITEM_NOT_SUPPORTED      restrictions at the institution; use a different account
//   NO_ACCOUNTS             no open accounts on the Item
const ACTION_AT_BANK_CODES = new Set([
  'ITEM_LOCKED',
  'PASSWORD_RESET_REQUIRED',
  'USER_SETUP_REQUIRED',
  'INSUFFICIENT_CREDENTIALS',
  'ITEM_NOT_SUPPORTED',
  'NO_ACCOUNTS',
])

// Genuinely transient. Sandbox essentially never produces these; production routinely does.
// NOTE: "RATE_LIMIT_EXCEEDED" is deliberately absent — it is Plaid's error_TYPE, never an
// error_code, so listing it here matched nothing at all. The real per-endpoint codes are below.
const TEMPORARY_CODES = new Set([
  'INSTITUTION_DOWN',
  'INSTITUTION_NOT_RESPONDING',
  'INSTITUTION_NOT_AVAILABLE',
  'PRODUCT_NOT_READY',
  'INTERNAL_SERVER_ERROR',
  'PLANNED_MAINTENANCE',
  // RATE_LIMIT_EXCEEDED family (the codes Plaid actually sends)
  'RATE_LIMIT',
  'INSTITUTION_RATE_LIMIT',
  'ACCOUNTS_LIMIT',
  'ACCOUNTS_BALANCE_GET_LIMIT',
  'TRANSACTIONS_LIMIT',
  'TRANSACTIONS_SYNC_LIMIT',
  'TRANSACTIONS_REFRESH_LIMIT',
  'ITEM_GET_LIMIT',
  'BALANCE_LIMIT',
  'IDENTITY_LIMIT',
  'AUTH_LIMIT',
])

// Our problem, not the bank's. INVALID_ACCESS_TOKEN in particular means the token "is invalid or
// pertains to a different API environment" — i.e. a sandbox token used against production, the
// exact mix-up the plaid_env column exists to prevent. Reported as "bank unavailable" it would
// hide the one failure this migration is most likely to produce.
const CONFIG_CODES = new Set([
  'INVALID_ACCESS_TOKEN',
  'INVALID_API_KEYS',
  'UNAUTHORIZED_ENVIRONMENT',
  'INVALID_PRODUCT',
  'ITEM_NOT_FOUND',
])

// A LOG-SAFE summary of a Plaid/axios error. NEVER log a raw Plaid error object: the axios error
// carries `config.headers` (which include PLAID-SECRET, the account-wide master credential) and
// `config.data` (the request body, which contains the decrypted access_token). Node's util.inspect
// serializes those verbatim, and Vercel persists stderr into viewable runtime logs — so logging the
// raw error on a routine bank outage would write the crown-jewel credentials to disk. This returns
// only the non-sensitive fields (Plaid's error body has no secrets) plus a plain message fallback.
export function plaidLogSafe(err: unknown): string {
  const e = err as {
    response?: { status?: number; data?: { error_type?: string; error_code?: string } }
    code?: string
    message?: string
  }
  const parts = [
    e?.response?.status != null ? `http=${e.response.status}` : null,
    e?.response?.data?.error_type ? `type=${e.response.data.error_type}` : null,
    e?.response?.data?.error_code ? `code=${e.response.data.error_code}` : null,
    e?.code ? `net=${e.code}` : null, // ECONNRESET / ETIMEDOUT etc. — no body, so no code above
  ].filter(Boolean)
  if (parts.length) return parts.join(' ')
  return e?.message ? e.message : String(err)
}

// Plaid's node SDK throws axios errors carrying the API error body on err.response.data.
export function plaidErrorCode(err: unknown): string | null {
  const code = (err as { response?: { data?: { error_code?: unknown } } })?.response?.data
    ?.error_code
  return typeof code === 'string' ? code : null
}

// Plaid ships user-facing wording for most Item errors. Prefer it over anything we invent.
export function plaidDisplayMessage(err: unknown): string | null {
  const msg = (err as { response?: { data?: { display_message?: unknown } } })?.response?.data
    ?.display_message
  return typeof msg === 'string' && msg.length > 0 ? msg : null
}

// An unrecognised code is treated as 'temporary': across Plaid's ~100 codes the unknown ones skew
// transient, and the alternative (claiming a permanent fault) would send the user to relink and
// spend a slot. The safeguard against a permanent error hiding in here is that Refresh reports
// failures and status_detail always carries the raw code.
export function classifyPlaidError(err: unknown): PlaidErrorCategory {
  const code = plaidErrorCode(err)
  if (code === null) return 'temporary'
  if (RECONNECT_CODES.has(code)) return 'reconnect'
  if (ACTION_AT_BANK_CODES.has(code)) return 'action_at_bank'
  if (CONFIG_CODES.has(code)) return 'config'
  if (TEMPORARY_CODES.has(code)) return 'temporary'
  return 'temporary'
}

export function isReconnectError(err: unknown): boolean {
  return classifyPlaidError(err) === 'reconnect'
}

export function isTemporaryError(err: unknown): boolean {
  return classifyPlaidError(err) === 'temporary'
}

// Swallowed by the disconnect route: the Item is already gone at Plaid, so deleting our row is
// the correct outcome rather than an error.
export function isAlreadyRemoved(err: unknown): boolean {
  const code = plaidErrorCode(err)
  return code === 'ITEM_NOT_FOUND' || code === 'INVALID_ACCESS_TOKEN'
}

// The 10-Item Trial ceiling, hit at link time. Deserves its own answer: "you are out of bank
// connections", never "try again later" — retrying can only fail, and each attempt is wasted.
export function isOutOfItemSlots(err: unknown): boolean {
  return plaidErrorCode(err) === 'TRIAL_CONNECTION_LIMIT'
}
