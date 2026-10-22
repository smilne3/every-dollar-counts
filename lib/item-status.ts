import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'

// A bank whose sync has just succeeded, after one that failed, has recovered on its own: the bank
// came back up, the lock cleared, and so on. Marked ok, it counts as syncing again, so the "isn't
// syncing" banner and the hidden savings average (#135) go. Refresh and Plaid's data-ready webhook
// both sync a bank, and both call this once a sync succeeds. Only Refresh used to, so a bank the
// webhooks had brought up to date stayed "isn't syncing" until someone pressed it (#191).
//
// Never a broken login: only Reconnect clears needs_reconnect (app/api/plaid/reconnect/route.ts),
// or the webhook once Plaid says the login was repaired outside this app (LOGIN_REPAIRED, #194).
// Refresh skips such a bank, but the webhook still stores its accounts, and a login Plaid has said
// will expire (PENDING_EXPIRATION, PENDING_DISCONNECT) works until it does. Cleared here, that
// warning would go with the next routine webhook. Nor one marked broken while this sync ran, by an
// ITEM webhook for the same bank: the status read before the sync can't show it, so the write
// itself leaves needs_reconnect alone. Plaid sends PENDING_DISCONNECT once.
//
// Answers the write's error, or null. The bank's data did sync, so each caller only logs it, and
// the flag is set again by the next sync that succeeds.
export async function markRecovered(item: { id: string; status: string }) {
  if (item.status === 'ok' || item.status === 'needs_reconnect') return null
  const { error } = await supabaseAdmin
    .from('plaid_items')
    .update({ status: 'ok', status_detail: null })
    .eq('id', item.id)
    .neq('status', 'needs_reconnect')
  return error
}
