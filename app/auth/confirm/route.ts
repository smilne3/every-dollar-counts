import { type EmailOtpType } from '@supabase/supabase-js'
import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Handles both auth email flows so it works with Supabase's default templates:
//  - PKCE code flow (?code=...)        -> exchangeCodeForSession
//  - token-hash flow (?token_hash&type) -> verifyOtp
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = searchParams.get('next') ?? '/dashboard'

  const supabase = await createClient()

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(new URL(next, request.url))
  } else if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash })
    if (!error) return NextResponse.redirect(new URL(next, request.url))
  }

  return NextResponse.redirect(new URL('/auth/auth-code-error', request.url))
}
