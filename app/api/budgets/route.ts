import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data } = await supabase.from('budgets').select('category, monthly_limit')
  return NextResponse.json({ budgets: data ?? [] })
}

// Bulk save: upsert categories with a positive limit, delete those set to 0/blank.
export async function POST(req: Request) {
  const { items } = await req.json()
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  if (!m) return NextResponse.json({ error: 'no household' }, { status: 403 })
  const household_id = m.household_id

  const toUpsert: { household_id: string; category: string; monthly_limit: number }[] = []
  const toDelete: string[] = []
  for (const it of items ?? []) {
    const limit = Number(it.monthly_limit)
    if (limit > 0) toUpsert.push({ household_id, category: it.category, monthly_limit: limit })
    else toDelete.push(it.category)
  }

  if (toUpsert.length) {
    const { error } = await supabase
      .from('budgets')
      .upsert(toUpsert, { onConflict: 'household_id,category' })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  }
  if (toDelete.length) {
    await supabase.from('budgets').delete().in('category', toDelete)
  }
  return NextResponse.json({ ok: true })
}
