import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

async function household(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  return m?.household_id ?? null
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')
  return NextResponse.json({ categories: data ?? [] })
}

// Add a custom category.
export async function POST(req: Request) {
  const { name } = await req.json()
  const clean = (name ?? '').trim()
  if (!clean) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const supabase = await createClient()
  const hid = await household(supabase)
  if (!hid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: top } = await supabase
    .from('categories')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .single()
  const sort_order = (top?.sort_order ?? 0) + 1

  const { error } = await supabase
    .from('categories')
    .insert({ household_id: hid, name: clean, pfc_primary: null, sort_order })
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}

// Rename a category (cascades the name onto transactions + budgets).
export async function PATCH(req: Request) {
  const { id, name } = await req.json()
  const clean = (name ?? '').trim()
  if (!id || !clean) return NextResponse.json({ error: 'id and name required' }, { status: 400 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: cat } = await supabase.from('categories').select('name').eq('id', id).single()
  if (!cat) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const oldName = cat.name

  const { error } = await supabase.from('categories').update({ name: clean }).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  await supabase.from('transactions').update({ user_category: clean }).eq('user_category', oldName)
  await supabase.from('budgets').update({ category: clean }).eq('category', oldName)
  return NextResponse.json({ ok: true })
}

// Delete a category (reverts its transactions to auto, drops its budget).
export async function DELETE(req: Request) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: cat } = await supabase.from('categories').select('name').eq('id', id).single()
  if (!cat) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const name = cat.name

  await supabase.from('categories').delete().eq('id', id)
  await supabase.from('transactions').update({ user_category: null }).eq('user_category', name)
  await supabase.from('budgets').delete().eq('category', name)
  return NextResponse.json({ ok: true })
}
