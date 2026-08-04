import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { pfcToName, type Category } from '@/lib/categories'
import { effectiveCategory } from '@/lib/effective-category'
import {
  claimTotals,
  allocateWriteOff,
  type Claim,
  type Split,
} from '@/lib/reimbursements'

async function household(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  return m?.household_id ?? null
}

// Every claim with its totals and per-person breakdown. RLS scopes all three reads to the household.
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: claims } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on')
    .order('created_at', { ascending: false })
  const { data: splits } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')
  const { data: txns } = await supabase.from('transactions').select('id, amount, date')

  const amountById: Record<string, number> = {}
  for (const t of txns ?? []) amountById[t.id as string] = Number(t.amount)

  const all = (splits ?? []) as Split[]
  const withTotals = ((claims ?? []) as Claim[]).map((c) => ({
    ...c,
    totals: claimTotals(
      c,
      all.filter((s) => s.claim_id === c.id),
      amountById
    ),
  }))
  return NextResponse.json({ claims: withTotals })
}

// Create a claim (called inline the first time a name is typed in the split editor), or write one
// off. Both are POST so the split editor can create-and-use in a single round trip.
export async function POST(req: Request) {
  const body = await req.json()
  const supabase = await createClient()
  const hid = await household(supabase)
  if (!hid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  if (body.action === 'write_off') {
    return writeOff(supabase, hid, body.id, body.onDate)
  }

  const name = (body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  // Idempotent on name: typing an existing claim's name in the editor reuses it rather than failing
  // on the unique constraint.
  const { data: existing } = await supabase
    .from('reimbursement_claims')
    .select('id')
    .eq('name', name)
    .maybeSingle()
  if (existing) return NextResponse.json({ id: existing.id })

  const { data, error } = await supabase
    .from('reimbursement_claims')
    .insert({ household_id: hid, name })
    .select('id')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ id: data.id })
}

// Giving up on a claim turns the unreturned amount into real spending, dated TODAY (not the original
// expense month — no closed month may change), allocated pro-rata across the categories it came from
// and then frozen as rows.
async function writeOff(
  supabase: Awaited<ReturnType<typeof createClient>>,
  hid: string,
  id: string,
  onDate?: string
) {
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const { data: claim } = await supabase
    .from('reimbursement_claims')
    .select('id, name, written_off_on')
    .eq('id', id)
    .single()
  if (!claim) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (claim.written_off_on) {
    return NextResponse.json({ error: 'already written off' }, { status: 400 })
  }

  const { data: splits } = await supabase
    .from('reimbursement_splits')
    .select('transaction_id, claim_id, owed_by, amount')
    .eq('claim_id', id)
  const { data: cats } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
  const pfcMap = pfcToName((cats ?? []) as Category[])

  const ids = [...new Set(((splits ?? []) as Split[]).map((s) => s.transaction_id))]
  const { data: txns } = await supabase
    .from('transactions')
    .select('id, amount, user_category, pfc_primary')
    .in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])

  const amountById: Record<string, number> = {}
  const categoryById: Record<string, string> = {}
  for (const t of txns ?? []) {
    amountById[t.id as string] = Number(t.amount)
    categoryById[t.id as string] = effectiveCategory(
      { user_category: t.user_category as string | null, pfc_primary: t.pfc_primary as string | null },
      pfcMap
    )
  }

  const date = onDate ?? new Date().toISOString().slice(0, 10)
  const rows = allocateWriteOff(
    claim as Claim,
    (splits ?? []) as Split[],
    categoryById,
    amountById,
    date
  )

  if (rows.length) {
    const { error } = await supabase
      .from('reimbursement_write_offs')
      .insert(rows.map((r) => ({ ...r, household_id: hid })))
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  }
  const { error: markError } = await supabase
    .from('reimbursement_claims')
    .update({ written_off_on: date })
    .eq('id', id)
  if (markError) return NextResponse.json({ error: markError.message }, { status: 400 })

  return NextResponse.json({ ok: true, written: rows })
}

export async function PATCH(req: Request) {
  const { id, name } = await req.json()
  const clean = (name ?? '').trim()
  if (!id || !clean) return NextResponse.json({ error: 'id and name required' }, { status: 400 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { error } = await supabase
    .from('reimbursement_claims')
    .update({ name: clean })
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}

// Deleting a claim cascades its splits (FK), so the money it was excluding returns to spending.
// The UI guards this with ConfirmDialog.
export async function DELETE(req: Request) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { error } = await supabase.from('reimbursement_claims').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
