import { describe, it, expect } from 'vitest'
import {
  plaidErrorCode,
  plaidDisplayMessage,
  classifyPlaidError,
  isReconnectError,
  isTemporaryError,
  isAlreadyRemoved,
  isOutOfItemSlots,
  type PlaidErrorCategory,
} from '@/lib/plaid-errors'

// Plaid's node SDK throws axios-shaped errors: err.response.data.error_code
function plaidError(code: string, display_message?: string) {
  return { response: { data: { error_code: code, display_message } } }
}

describe('plaidErrorCode', () => {
  it('pulls the error_code from an axios-shaped Plaid error', () => {
    expect(plaidErrorCode(plaidError('ITEM_LOGIN_REQUIRED'))).toBe('ITEM_LOGIN_REQUIRED')
  })
  it('returns null for a plain Error or nullish input', () => {
    expect(plaidErrorCode(new Error('boom'))).toBeNull()
    expect(plaidErrorCode(null)).toBeNull()
    expect(plaidErrorCode(undefined)).toBeNull()
  })
})

describe('plaidDisplayMessage', () => {
  it('returns Plaid’s own user-facing wording when present', () => {
    expect(plaidDisplayMessage(plaidError('ITEM_LOCKED', 'Your account is locked.'))).toBe(
      'Your account is locked.'
    )
  })
  it('returns null when absent or empty', () => {
    expect(plaidDisplayMessage(plaidError('ITEM_LOCKED'))).toBeNull()
    expect(plaidDisplayMessage(plaidError('ITEM_LOCKED', ''))).toBeNull()
    expect(plaidDisplayMessage(new Error('boom'))).toBeNull()
  })
})

// Every classified code is pinned here by name. This is the point of the table: dropping a code
// from a set in the implementation must break a test. Without it, losing a reconnect code silently
// downgrades that bank to "wait it out" — no Reconnect button, no sync, and no signal, forever.
const TABLE: [string, PlaidErrorCategory][] = [
  // reconnect — Link update mode fixes it, costs no Item slot
  ['ITEM_LOGIN_REQUIRED', 'reconnect'],
  ['ACCESS_NOT_GRANTED', 'reconnect'],
  ['INVALID_UPDATED_USERNAME', 'reconnect'],
  ['MANUAL_VERIFICATION_REQUIRED', 'reconnect'],
  ['USER_PERMISSION_REVOKED', 'reconnect'],
  // action_at_bank — Plaid's documented remedy is at the institution, NOT update mode
  ['ITEM_LOCKED', 'action_at_bank'],
  ['PASSWORD_RESET_REQUIRED', 'action_at_bank'],
  ['USER_SETUP_REQUIRED', 'action_at_bank'],
  ['INSUFFICIENT_CREDENTIALS', 'action_at_bank'],
  ['ITEM_NOT_SUPPORTED', 'action_at_bank'],
  ['NO_ACCOUNTS', 'action_at_bank'],
  // temporary — genuinely transient
  ['INSTITUTION_DOWN', 'temporary'],
  ['INSTITUTION_NOT_RESPONDING', 'temporary'],
  ['INSTITUTION_NOT_AVAILABLE', 'temporary'],
  ['PRODUCT_NOT_READY', 'temporary'],
  ['INTERNAL_SERVER_ERROR', 'temporary'],
  ['PLANNED_MAINTENANCE', 'temporary'],
  ['RATE_LIMIT', 'temporary'],
  ['INSTITUTION_RATE_LIMIT', 'temporary'],
  ['TRANSACTIONS_SYNC_LIMIT', 'temporary'],
  ['ACCOUNTS_BALANCE_GET_LIMIT', 'temporary'],
  // config — ours to fix; must never render as "the bank is having trouble"
  ['INVALID_ACCESS_TOKEN', 'config'],
  ['INVALID_API_KEYS', 'config'],
  ['UNAUTHORIZED_ENVIRONMENT', 'config'],
  ['ITEM_NOT_FOUND', 'config'],
]

const TEMPORARY_LIST = TABLE.filter(([, c]) => c === 'temporary').map(([code]) => code)

describe('classifyPlaidError', () => {
  for (const [code, expected] of TABLE) {
    it(`classifies ${code} as ${expected}`, () => {
      expect(classifyPlaidError(plaidError(code))).toBe(expected)
    })
  }

  it('treats an unrecognised code as temporary rather than inventing a permanent fault', () => {
    expect(classifyPlaidError(plaidError('SOME_FUTURE_CODE'))).toBe('temporary')
  })
  it('treats a non-Plaid error as temporary', () => {
    expect(classifyPlaidError(new Error('network'))).toBe('temporary')
  })

  // RATE_LIMIT_EXCEEDED is Plaid's error_TYPE, never an error_code. An earlier version of this
  // file listed it as a code, so the one entry meant to cover rate limiting matched nothing.
  it('does not pretend RATE_LIMIT_EXCEEDED is a code (it is an error_type)', () => {
    expect(TEMPORARY_LIST).not.toContain('RATE_LIMIT_EXCEEDED')
  })
})

describe('isReconnectError / isTemporaryError', () => {
  it('agree with the classifier and never both fire for one code', () => {
    for (const [code] of TABLE) {
      const err = plaidError(code)
      expect(isReconnectError(err) && isTemporaryError(err)).toBe(false)
    }
  })
  it('is false for a config error — reconnecting cannot fix our own misconfiguration', () => {
    expect(isReconnectError(plaidError('INVALID_ACCESS_TOKEN'))).toBe(false)
    expect(isTemporaryError(plaidError('INVALID_ACCESS_TOKEN'))).toBe(false)
  })
  it('is false for a bank-side action — a Reconnect button there just fails again', () => {
    expect(isReconnectError(plaidError('ITEM_LOCKED'))).toBe(false)
  })
})

describe('isAlreadyRemoved', () => {
  it('is true only for the codes meaning the Item is already gone at Plaid', () => {
    expect(isAlreadyRemoved(plaidError('ITEM_NOT_FOUND'))).toBe(true)
    expect(isAlreadyRemoved(plaidError('INVALID_ACCESS_TOKEN'))).toBe(true)
    expect(isAlreadyRemoved(plaidError('INSTITUTION_DOWN'))).toBe(false)
    expect(isAlreadyRemoved(new Error('network'))).toBe(false)
  })
})

describe('isOutOfItemSlots', () => {
  // The 10-Item Trial ceiling. Must be its own answer: retrying can only fail.
  it('detects the Trial connection limit', () => {
    expect(isOutOfItemSlots(plaidError('TRIAL_CONNECTION_LIMIT'))).toBe(true)
    expect(isOutOfItemSlots(plaidError('RATE_LIMIT'))).toBe(false)
  })
})
