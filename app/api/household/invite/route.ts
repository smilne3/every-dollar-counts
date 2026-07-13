import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Add an email to the household's invite allowlist. They join on their first
// sign-in (Google or email link) — no invite email is sent.
export async function POST(req: Request) {
  const { email, household_id } = await req.json()
  const clean = (email ?? '').trim().toLowerCase()
  if (!clean || !household_id) {
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

  const { error } = await supabase
    .from('invites')
    .upsert({ email: clean, household_id }, { onConflict: 'email' })
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ ok: true })
}
