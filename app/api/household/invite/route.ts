import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  const { email, household_id } = await req.json()
  if (!email || !household_id) {
    return NextResponse.json({ error: 'email and household_id required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Verify the caller belongs to this household (RLS-scoped read).
  const { data: mine } = await supabase
    .from('memberships')
    .select('household_id')
    .eq('household_id', household_id)
  if (!mine?.length) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${new URL(req.url).origin}/auth/confirm`,
  })
  if (error || !data?.user) {
    return NextResponse.json({ error: error?.message ?? 'invite failed' }, { status: 400 })
  }

  const { error: mErr } = await supabaseAdmin
    .from('memberships')
    .insert({ user_id: data.user.id, household_id })
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 400 })

  return NextResponse.json({ ok: true })
}
