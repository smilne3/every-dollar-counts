import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkSignIn } from '@/lib/auth-check'
import { assertEnvMatchesDatabase, envGuardResponse } from '@/lib/app-env'
import { unknownIfLost } from '@/lib/lost-reply'

type Supabase = Awaited<ReturnType<typeof createClient>>

const TRY_AGAIN = 'That could not be saved. Please try again.'

// Sign-in, by the rule in lib/auth-check.ts (#143): a 503 when Supabase Auth could not be asked,
// in words CategoryManager shows as they stand, and a 401 when the session has ended. Null when
// signed in. Every handler runs it before touching the database.
async function refusedSignIn(supabase: Supabase, unchecked: string): Promise<NextResponse | null> {
  const signIn = await checkSignIn(supabase, '[categories]')
  if (signIn.state === 'unknown') return NextResponse.json({ error: unchecked }, { status: 503 })
  if (signIn.state === 'ended') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return null
}

async function household(supabase: Supabase) {
  const { data: m } = await supabase.from('memberships').select('household_id').limit(1).single()
  return m?.household_id ?? null
}

export async function GET() {
  const supabase = await createClient()
  const refused = await refusedSignIn(supabase, 'Your categories could not be loaded. Please try again.')
  if (refused) return refused
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
  const refused = await refusedSignIn(supabase, TRY_AGAIN)
  if (refused) return refused
  const hid = await household(supabase)
  if (!hid) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: top } = await supabase
    .from('categories')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .single()
  const sort_order = (top?.sort_order ?? 0) + 1

  const { error, status } = await supabase
    .from('categories')
    .insert({ household_id: hid, name: clean, pfc_primary: null, sort_order })
  // An add the database never answered may have landed, so its outcome is unknown
  // (lib/lost-reply.ts). Names are unique per household, so adding it again cannot make two.
  if (error) return unknownIfLost(status, error) ?? NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}

// Rename a category (cascades the name onto transactions + budgets).
export async function PATCH(req: Request) {
  const { id, name } = await req.json()
  const clean = (name ?? '').trim()
  if (!id || !clean) return NextResponse.json({ error: 'id and name required' }, { status: 400 })
  const supabase = await createClient()
  const refused = await refusedSignIn(supabase, TRY_AGAIN)
  if (refused) return refused

  const { data: cat } = await supabase.from('categories').select('name').eq('id', id).single()
  if (!cat) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const oldName = cat.name

  const { error, status } = await supabase.from('categories').update({ name: clean }).eq('id', id)
  // A rename the database never answered may have landed, so its outcome is unknown
  // (lib/lost-reply.ts), and the cascades below do not run. Their own errors are never read (#100),
  // so a lost reply there still answers ok.
  if (error) return unknownIfLost(status, error) ?? NextResponse.json({ error: error.message }, { status: 400 })
  await supabase.from('transactions').update({ user_category: clean }).eq('user_category', oldName)
  await supabase.from('budgets').update({ category: clean }).eq('category', oldName)
  return NextResponse.json({ ok: true })
}

// Delete a category: its rules go with it (FK), its picks revert to auto, its budget is dropped.
export async function DELETE(req: Request) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const supabase = await createClient()
  const refused = await refusedSignIn(supabase, 'That category could not be deleted. Please try again.')
  if (refused) return refused
  // Guarded because deleting a category now deletes its rules too (category_rules' FK, #28 spec
  // §6.3). PATCH also rewrites picks and budgets in the shared database but touches no rule; whether
  // to guard it is #148.
  try {
    await assertEnvMatchesDatabase()
  } catch (e) {
    return envGuardResponse(e, {
      tag: '[categories]',
      mismatch: 'This app is pointed at a database from a different environment. Nothing deleted.',
      unreadable: 'Could not verify which database this is, so nothing was deleted.',
    })
  }

  const { data: cat } = await supabase.from('categories').select('name').eq('id', id).single()
  if (!cat) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const name = cat.name

  // None of these three reads its error, so a refusal answers ok as well as a lost reply does (#100).
  // Once they do, a delete the database never answered is unknown (lib/lost-reply.ts), as above.
  await supabase.from('categories').delete().eq('id', id)
  await supabase.from('transactions').update({ user_category: null }).eq('user_category', name)
  await supabase.from('budgets').delete().eq('category', name)
  return NextResponse.json({ ok: true })
}
