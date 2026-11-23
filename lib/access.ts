import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'

// What app/auth/confirm/route.ts does with a sign-in:
// - 'let-in': a member, or one their invite has just made. A member's invite to their own household,
//   if one was left behind, is used up on the way (#248). Also when the membership read fails: an
//   existing member gets through a passing failure, and RLS still keeps anyone from data that isn't
//   theirs (#240 kept this).
// - 'try-again': not a member, and their invite couldn't be read or used. Let in, they'd find no
//   household and the invite never used (#240), so they're signed out and asked to sign in again,
//   which runs this check again.
// - 'not-invited': affirmatively neither a member nor invited. Their throwaway account is deleted, and
//   a failed delete is logged (#249). The route signs their new session out either way.
export type Access = 'let-in' | 'try-again' | 'not-invited'

// Postgres's unique violation. On the membership insert, the membership already exists.
const ALREADY_EXISTS = '23505'

// Enforce invite-only access at login (any provider).
//
// Safety rule: NEVER delete a user on a query/insert error — a transient failure
// must not nuke a legitimate account. Only 'not-invited' deletes, and only once
// the reads have answered that there's nothing to find: no membership, and no
// invite, or no email for one to name.
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
  if (mem && mem.length) {
    await clearUsedInvite(email, mem[0].household_id as string)
    return 'let-in'
  }

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
      // A membership that already exists is one a second sign-in, racing this one,
      // has just made: they're a member, so on as if this insert had made it.
      if (insErr && insErr.code !== ALREADY_EXISTS) {
        console.error('[access] could not add the invited person to the household, so ask them to sign in again', { code: insErr.code, message: insErr.message })
        return 'try-again'
      }
      const { error: delErr } = await supabaseAdmin.from('invites').delete().eq('email', e)
      // They're a member, so they're let in either way. Logged, because the invite left behind would
      // add them back if they were ever removed from the household by hand (#248).
      if (delErr) {
        console.error('[access] could not use up the invite of someone now in the household', { code: delErr.code, message: delErr.message })
      }
      return 'let-in'
    }
  }

  // Affirmatively not a member and not invited -> remove the throwaway account. Still not invited if
  // that fails, so the answer stands. Logged, because the account left behind can now be sent email
  // sign-in links, which won't create one (#249).
  const { error: delUserErr } = await supabaseAdmin.auth.admin.deleteUser(userId)
  if (delUserErr) {
    console.error('[access] could not remove the uninvited account', { status: delUserErr.status, code: delUserErr.code, message: delUserErr.message })
  }
  return 'not-invited'
}

// A member's invite to the household they're in, used up. One is left behind when using it up failed,
// or when the membership insert landed but its reply was lost and they signed in again. Left, it's
// still an allowlist entry that nothing shows, and it would add them back if they were ever removed
// from the household by hand (#248). Only this household's: an invite from another household is that
// household's to use or withdraw. Sign-ins are rare, so the extra delete costs little. A failed delete
// is logged and never keeps a member out.
async function clearUsedInvite(email: string | undefined, householdId: string) {
  const e = (email ?? '').toLowerCase()
  if (!e) return
  const { error } = await supabaseAdmin.from('invites').delete().eq('email', e).eq('household_id', householdId)
  if (error) {
    console.error('[access] could not clear the used invite of a member', { code: error.code, message: error.message })
  }
}
