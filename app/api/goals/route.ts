import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data } = await supabase
    .from('goals')
    .select('id, name, target_amount, saved_amount')
    .order('created_at')
  return NextResponse.json({ goals: data ?? [] })
}

export async function POST(req: Request) {
  const { name, target_amount } = await req.json()
  const clean = (name ?? '').trim()
  const target = Number(target_amount)
  if (!clean || !(target > 0)) {
    return NextResponse.json({ error: 'name and a positive target are required' }, { status: 400 })
  }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  if (!m) return NextResponse.json({ error: 'no household' }, { status: 403 })

  const { error } = await supabase
    .from('goals')
    .insert({ household_id: m.household_id, name: clean, target_amount: target, saved_amount: 0 })
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: Request) {
  const { id, saved_amount, name, target_amount } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const patch: Record<string, number | string> = {}
  if (saved_amount !== undefined && Number.isFinite(Number(saved_amount))) {
    patch.saved_amount = Math.max(0, Number(saved_amount))
  }
  if (name !== undefined && String(name).trim()) patch.name = String(name).trim()
  if (target_amount !== undefined && Number(target_amount) > 0) patch.target_amount = Number(target_amount)
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing valid to update' }, { status: 400 })
  }

  const { error } = await supabase.from('goals').update(patch).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { error } = await supabase.from('goals').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
