import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'

// Enforce invite-only access at login (any provider). Returns true if the user
// is/becomes a household member; false (and deletes the throwaway user) ONLY when
// we can affirmatively determine they are neither a member nor invited.
//
// Safety rule: NEVER delete a user on a query/insert error — a transient failure
// must not nuke a legitimate account. On uncertainty we fail OPEN (return true);
// RLS still prevents them from seeing any data they aren't a member of.
export async function ensureHouseholdAccess(
  userId: string,
  email: string | undefined
): Promise<boolean> {
  const { data: mem, error: memErr } = await supabaseAdmin
    .from('memberships')
    .select('household_id')
    .eq('user_id', userId)
    .limit(1)
  if (memErr) return true // can't verify membership -> do NOT delete
  if (mem && mem.length) return true

  const e = (email ?? '').toLowerCase()
  if (e) {
    const { data: inv, error: invErr } = await supabaseAdmin
      .from('invites')
      .select('household_id')
      .eq('email', e)
      .maybeSingle()
    if (invErr) return true // can't verify invite -> do NOT delete
    if (inv) {
      const { error: insErr } = await supabaseAdmin
        .from('memberships')
        .insert({ user_id: userId, household_id: inv.household_id })
      // Only consume the invite once the membership actually exists; on failure
      // keep the invite so the next login can retry, and never delete the user.
      if (insErr) return true
      await supabaseAdmin.from('invites').delete().eq('email', e)
      return true
    }
  }

  // Affirmatively not a member and not invited -> remove the throwaway account.
  await supabaseAdmin.auth.admin.deleteUser(userId)
  return false
}
