import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'

// Enforce invite-only access at login (any provider). Returns true if the user
// is/becomes a household member; false (and deletes the throwaway user) otherwise.
export async function ensureHouseholdAccess(
  userId: string,
  email: string | undefined
): Promise<boolean> {
  const { data: mem } = await supabaseAdmin
    .from('memberships')
    .select('household_id')
    .eq('user_id', userId)
    .limit(1)
  if (mem && mem.length) return true

  const e = (email ?? '').toLowerCase()
  if (e) {
    const { data: inv } = await supabaseAdmin
      .from('invites')
      .select('household_id')
      .eq('email', e)
      .maybeSingle()
    if (inv) {
      await supabaseAdmin
        .from('memberships')
        .insert({ user_id: userId, household_id: inv.household_id })
      await supabaseAdmin.from('invites').delete().eq('email', e)
      return true
    }
  }

  // Not invited — remove the just-created account so no orphans accumulate.
  await supabaseAdmin.auth.admin.deleteUser(userId)
  return false
}
