import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Re-categorize a transaction. Runs as the user, so RLS ("update your txns")
// enforces that they can only touch their own household's rows.
export async function POST(req: Request) {
  const { transactionId, category } = await req.json()
  if (!transactionId) {
    return NextResponse.json({ error: 'transactionId required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { error } = await supabase
    .from('transactions')
    .update({ user_category: category || null })
    .eq('id', transactionId)

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
