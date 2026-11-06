import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkSignIn } from '@/lib/auth-check'
import { assertEnvMatchesDatabase, envGuardResponse } from '@/lib/app-env'
import { refusedCategoryName } from '@/lib/category-names'
import { unknownIfLost } from '@/lib/lost-reply'
import { SESSION_ENDED } from '@/lib/save-response'

type Supabase = Awaited<ReturnType<typeof createClient>>

const TRY_AGAIN = 'That could not be saved. Please try again.'
const NOT_LOADED = 'Your categories could not be loaded. Please try again.'
const NOT_DELETED = 'That category could not be deleted. Please try again.'
// CategoryManager reloads on a 404 or a 409, so the list under these is the latest.
const GONE = 'That category no longer exists. Showing the latest.'
const NAME_TAKEN = 'That name is already a category.'

// The two refusals a write answers with a status of its own, 404 and 409, rather than a 500.
const ALREADY_EXISTS = '23505' // unique (household_id, name) on categories, 007
const NO_SUCH_CATEGORY = 'P0002' // raised by rename_category and delete_category, 023

// Sign-in, by the rule in lib/auth-check.ts (#143): a 503 when Supabase Auth could not be asked,
// and a 401 when the session has ended, each in words CategoryManager shows as they stand. Null
// when signed in. Every handler runs it before touching the database.
async function refusedSignIn(supabase: Supabase, unchecked: string): Promise<NextResponse | null> {
  const signIn = await checkSignIn(supabase, '[categories]')
  if (signIn.state === 'unknown') return NextResponse.json({ error: unchecked }, { status: 503 })
  if (signIn.state === 'ended') return NextResponse.json({ error: SESSION_ENDED }, { status: 401 })
  return null
}

// Local dev and Previews share production's database, so each write here would change the
// household's real data from wherever it was sent. A delete takes the category's rules with it (its
// FK, #28 spec §6.3). A rename moves the category's picks and budgets onto the new name. An add, a
// rename or a delete changes the catalogue fingerprint (lib/category-rules.ts), which hides every
// stored Jev suggestion until syncs ask again (#154). So each refuses to write from an app in another
// environment, before any read (#148). Null when the environments match.
async function refusedEnvironment(nothing: 'added' | 'renamed' | 'deleted'): Promise<NextResponse | null> {
  try {
    await assertEnvMatchesDatabase()
    return null
  } catch (e) {
    return envGuardResponse(e, {
      tag: '[categories]',
      mismatch: `This app is pointed at a database from a different environment. Nothing ${nothing}.`,
      unreadable: `Could not verify which database this is, so nothing was ${nothing}.`,
    })
  }
}

// A read that failed: a 500 in the handler's own words, before anything is written, and a log line
// naming the read. Before #241 a failed read was taken as no row: the membership read answered
// "unauthorized", the highest sort_order read saved a new category at 1, near the top instead of
// last, and nothing was logged.
function failedRead(
  what: string,
  error: { code?: string; message: string },
  words: string,
  details: Record<string, unknown> = {}
) {
  console.error(`[categories] could not read ${what}`, { ...details, code: error.code, message: error.message })
  return NextResponse.json({ error: words }, { status: 500 })
}
// A list read with neither rows nor an error is postgrest-js's reading of an empty reply, so it's a
// failed read too, as lib/read-all.ts treats it, not an empty list (#222).
const NO_DATA = { message: 'read returned no data and no error' }

// A write that failed, logged first with its status, as every write route logs before deciding
// what to answer. One whose reply was lost may have landed, so its outcome is unknown
// (lib/lost-reply.ts). A refusal wrote nothing. A category that's gone is a 404, and a name another
// category has a 409. Any other refusal is answered in the handler's words. The database's own
// words, such as "duplicate key value violates unique constraint", reached the screen as they
// stood (#246).
function failedWrite(
  what: string,
  status: number,
  error: { code?: string; message: string },
  words: string,
  details: Record<string, unknown> = {}
) {
  console.error(`[categories] could not ${what}`, { ...details, status, code: error.code, message: error.message })
  const lost = unknownIfLost(status, error)
  if (lost) return lost
  if (error.code === NO_SUCH_CATEGORY) return NextResponse.json({ error: GONE }, { status: 404 })
  if (error.code === ALREADY_EXISTS) return NextResponse.json({ error: NAME_TAKEN }, { status: 409 })
  return NextResponse.json({ error: words }, { status: 500 })
}

// A name the app already uses for something else (lib/category-names.ts), refused before anything
// else, as it can never be saved. Null for any other name.
function refusedName(name: string): NextResponse | null {
  const words = refusedCategoryName(name)
  return words ? NextResponse.json({ error: words }, { status: 400 }) : null
}

export async function GET() {
  const supabase = await createClient()
  const refused = await refusedSignIn(supabase, NOT_LOADED)
  if (refused) return refused
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, pfc_primary, sort_order')
    .order('sort_order')
  if (error) return failedRead('the categories', error, NOT_LOADED)
  if (!data) return failedRead('the categories', NO_DATA, NOT_LOADED)
  return NextResponse.json({ categories: data })
}

// Add a custom category.
export async function POST(req: Request) {
  const { name } = await req.json()
  const clean = (name ?? '').trim()
  if (!clean) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const supabase = await createClient()
  const refused = refusedName(clean) ?? (await refusedSignIn(supabase, TRY_AGAIN)) ?? (await refusedEnvironment('added'))
  if (refused) return refused
  const { data: m, error: mError } = await supabase.from('memberships').select('household_id').limit(1).maybeSingle()
  if (mError) return failedRead('the household', mError, TRY_AGAIN)
  if (!m) return NextResponse.json({ error: "Your account isn't part of a household." }, { status: 403 })

  // A new category goes last. Read as a list, not with maybeSingle: that turns an empty reply into no
  // row as well as an empty list, so a failed read would still save the category at 1. Only an
  // empty list starts a household's first category at 1.
  const { data: tops, error: topError } = await supabase
    .from('categories')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
  if (topError) return failedRead('the highest sort_order', topError, TRY_AGAIN)
  if (!tops) return failedRead('the highest sort_order', NO_DATA, TRY_AGAIN)
  const sort_order = (tops[0]?.sort_order ?? 0) + 1

  const { error, status } = await supabase
    .from('categories')
    .insert({ household_id: m.household_id, name: clean, pfc_primary: null, sort_order })
  // Names are unique per household, so adding one again after a lost reply can't make two. If the
  // first landed, the second is answered as a name that's taken.
  if (error) return failedWrite('add the category', status, error, TRY_AGAIN)
  return NextResponse.json({ ok: true })
}

// Rename a category. rename_category (db/migrations/023) moves its picks and budget onto the new
// name in the same transaction, so all of it happens or none does (#100).
export async function PATCH(req: Request) {
  const { id, name } = await req.json()
  const clean = (name ?? '').trim()
  if (!id || !clean) return NextResponse.json({ error: 'id and name required' }, { status: 400 })
  const supabase = await createClient()
  const refused = refusedName(clean) ?? (await refusedSignIn(supabase, TRY_AGAIN)) ?? (await refusedEnvironment('renamed'))
  if (refused) return refused

  const { error, status } = await supabase.rpc('rename_category', { category_id: id, new_name: clean })
  if (error) return failedWrite('rename the category', status, error, TRY_AGAIN, { id })
  return NextResponse.json({ ok: true })
}

// Delete a category. delete_category (db/migrations/023) takes its rules with it (FK), returns its
// picks to automatic and drops its budget, all in one transaction (#100).
export async function DELETE(req: Request) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const supabase = await createClient()
  const refused = (await refusedSignIn(supabase, NOT_DELETED)) ?? (await refusedEnvironment('deleted'))
  if (refused) return refused

  const { error, status } = await supabase.rpc('delete_category', { category_id: id })
  if (error) return failedWrite('delete the category', status, error, NOT_DELETED, { id })
  return NextResponse.json({ ok: true })
}
