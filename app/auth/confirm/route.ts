import { type EmailOtpType } from '@supabase/supabase-js'
import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkSignIn } from '@/lib/auth-check'
import { ensureHouseholdAccess } from '@/lib/access'

// Handles both auth email flows AND OAuth (Google), then enforces invite-only access:
//  - PKCE code flow (?code=...)         -> exchangeCodeForSession   [magic link + OAuth]
//  - token-hash flow (?token_hash&type) -> verifyOtp                [admin-generated links]
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = searchParams.get('next') ?? '/dashboard'

  const supabase = await createClient()

  let ok = false
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    ok = !error
  } else if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash })
    ok = !error
  }
  if (!ok) return NextResponse.redirect(new URL('/auth/auth-code-error', request.url))

  // A failed check used to send the person to "Not invited yet" (#143). When Supabase Auth could not
  // be asked, nothing showed they aren't invited: they are told sign-in couldn't be completed, and to
  // try again, which runs the invite check too. One whose session has ended is sent to sign in again.
  const signIn = await checkSignIn(supabase, '[auth/confirm]')
  if (signIn.state === 'unknown') return NextResponse.redirect(new URL('/auth/try-again', request.url))
  if (signIn.state === 'ended') return NextResponse.redirect(new URL('/login', request.url))
  if (await ensureHouseholdAccess(signIn.user.id, signIn.user.email)) {
    return NextResponse.redirect(new URL(next, request.url))
  }
  return NextResponse.redirect(new URL('/auth/not-invited', request.url))
}
