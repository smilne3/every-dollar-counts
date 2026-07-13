import { NextResponse } from 'next/server'
import { CountryCode, Products } from 'plaid'
import { plaidClient } from '@/lib/plaid'
import { createClient } from '@/lib/supabase/server'

export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const r = await plaidClient.linkTokenCreate({
    user: { client_user_id: user.id },
    client_name: 'Every Dollar Counts',
    products: [Products.Transactions],
    language: 'en',
    country_codes: [CountryCode.Us],
  })

  return NextResponse.json({ link_token: r.data.link_token })
}
