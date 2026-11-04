import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'

// What app/auth/confirm/route.ts does with a sign-in:
// - 'let-in': a member, or one their invite has just made. Also when the membership read fails: an
//   existing member gets through a passing failure, and RLS still keeps anyone from data that isn't
//   theirs (#240 kept this).
// - 'try-again': not a member, and their invite couldn't be read or used. Let in, they'd find no
//   household and the invite never used (#240), so they're signed out and asked to sign in again,
//   which runs this check again.
// - 'not-invited': affirmatively neither a member nor invited. Their throwaway account is deleted.
export type Access = 'let-in' | 'try-again' | 'not-invited'

// Enforce invite-only access at login (any provider).
//
// Safety rule: NEVER delete a user on a query/insert error — a transient failure
// must not nuke a legitimate account. Only 'not-invited' deletes, and only once
// both reads have answered that there's nothing to find.
export async function ensureHouseholdAccess(
  userId: string,
  email: string | undefined
): Promise<Access> {
  const { data: mem, error: memErr } = await supabaseAdmin
    .from('memberships')
    .select('household_id')
    .eq('user_id', userId)
    .limit(1)
  // Logged, because letting someone in unchecked leaves no other trace. An invited first-timer then
  // finds no household until they sign in again (#202).
  if (memErr) {
    // can't verify membership -> do NOT delete
    console.error('[access] could not read the membership, so let the sign-in through', { code: memErr.code, message: memErr.message })
    return 'let-in'
  }
  if (mem && mem.length) return 'let-in'

  const e = (email ?? '').toLowerCase()
  if (e) {
    const { data: inv, error: invErr } = await supabaseAdmin
      .from('invites')
      .select('household_id')
      .eq('email', e)
      .maybeSingle()
    if (invErr) {
      // can't verify invite -> do NOT delete. Not a member either, so letting them in helps no one.
      console.error('[access] could not read the invite, so ask them to sign in again', { code: invErr.code, message: invErr.message })
      return 'try-again'
    }
    if (inv) {
      const { error: insErr } = await supabaseAdmin
        .from('memberships')
        .insert({ user_id: userId, household_id: inv.household_id })
      // Only consume the invite once the membership actually exists; on failure
      // keep the invite so signing in again can retry, and never delete the user.
      if (insErr) {
        console.error('[access] could not add the invited person to the household, so ask them to sign in again', { code: insErr.code, message: insErr.message })
        return 'try-again'
      }
      await supabaseAdmin.from('invites').delete().eq('email', e)
      return 'let-in'
    }
  }

  // Affirmatively not a member and not invited -> remove the throwaway account.
  await supabaseAdmin.auth.admin.deleteUser(userId)
  return 'not-invited'
}
