import { isAuthRetryableFetchError, type EmailOtpType } from '@supabase/supabase-js'
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

  // Supabase Auth's answer to the code or the token, or null when neither came.
  const answer = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : token_hash && type
      ? await supabase.auth.verifyOtp({ type, token_hash })
      : null
  const error = answer ? answer.error : null
  // One Supabase Auth never answered says nothing about the link (#143), so it goes where an
  // unanswered check below does, not to "That link didn't work". A link that came with neither, or
  // one Supabase Auth refused, did not work.
  if (isAuthRetryableFetchError(error)) {
    console.error('[auth/confirm] sign-in exchange failed', { status: error.status, message: error.message })
    return NextResponse.redirect(new URL('/auth/try-again', request.url))
  }
  if (!answer || error) return NextResponse.redirect(new URL('/auth/auth-code-error', request.url))

  // A failed check used to send the person to "Not invited yet" (#143). When Supabase Auth could not
  // be asked, nothing showed they aren't invited: they are told sign-in couldn't be completed, and to
  // try again, which runs the invite check too. One whose session has ended is sent to sign in again.
  const signIn = await checkSignIn(supabase, '[auth/confirm]')
  if (signIn.state === 'unknown') {
    // The exchange above has set the new session's cookie. Kept, it would let the person open the
    // app with the invite check never run, and an invited first-timer would find no household. So
    // it is signed out here, before the redirect carries the cookies: supabase-js removes a session
    // this fresh even when Supabase Auth can't be told, so its answer changes nothing.
    await supabase.auth.signOut({ scope: 'local' })
    return NextResponse.redirect(new URL('/auth/try-again', request.url))
  }
  if (signIn.state === 'ended') {
    // Moments after a sign-in that worked, so not something to pass over.
    const { error } = signIn
    console.error('[auth/confirm] session ended right after sign-in', { status: error?.status, code: error?.code, message: error?.message })
    return NextResponse.redirect(new URL('/login', request.url))
  }
  if (await ensureHouseholdAccess(signIn.user.id, signIn.user.email)) {
    return NextResponse.redirect(new URL(next, request.url))
  }
  return NextResponse.redirect(new URL('/auth/not-invited', request.url))
}
