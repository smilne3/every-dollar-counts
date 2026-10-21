import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { checkSignIn } from '@/lib/auth-check'

// What an /api request is told when Supabase Auth cannot be asked (#143). The request went no
// further, so nothing was saved. Its control shows this as it stands, as it does a route's own
// { error } (lib/save-response.ts), and since it answers for every route, it names none of them.
const AUTH_UNCHECKED = "Couldn't check your sign-in, so that didn't go through. Please try again."

// Next.js 16: "middleware" is now "proxy". Refreshes the Supabase session cookie
// and does an optimistic auth redirect. Real authorization is enforced by
// getUser() in server components + Postgres RLS — not here.
export async function proxy(request: NextRequest) {
  let res = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(list) {
          list.forEach(({ name, value }) => request.cookies.set(name, value))
          res = NextResponse.next({ request })
          list.forEach(({ name, value, options }) => res.cookies.set(name, value, options))
        },
      },
    }
  )

  // IMPORTANT: no code between createServerClient and getUser(), which checkSignIn calls first.
  const signIn = await checkSignIn(supabase, '[proxy]')

  const { pathname } = request.nextUrl
  // /plaid/oauth is where a bank returns the user after its own login. That trip routinely takes
  // several minutes of MFA and app-switching — long enough for a session to lapse — and without
  // this exemption the return is redirected to /login, losing the connection while the Item
  // already exists at Plaid and its slot is already spent.
  // Safe: the page renders no household data, it only re-opens the Plaid widget, and every route
  // it calls (exchange-public-token, reconnect) independently verifies the session and household.
  const isPublic =
    pathname.startsWith('/login') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/plaid/oauth') ||
    // Plaid POSTs webhooks here with no session. The route guards itself with a shared secret on
    // the URL; without this exemption the login gate 307s Plaid to /login and no webhook is ever
    // processed — which silently disables the one thing that warns a bank is about to disconnect.
    pathname.startsWith('/api/plaid/webhook')
  if (isPublic || signIn.state === 'signed-in') return res

  // Supabase Auth could not be asked (#143), so the session may be fine: sent to /login, everyone
  // would be signed out by an outage. A page goes on: app/(app)/layout.tsx checks again, and if it
  // still can't, app/error.tsx says sign-in couldn't be checked. An /api request is answered here,
  // with any cookie the check refreshed before it failed: Supabase has already rotated that refresh
  // token, and the old one, sent again, is refused as already used, which ends the session.
  if (signIn.state === 'unknown') {
    if (!pathname.startsWith('/api/')) return res
    const unchecked = NextResponse.json({ error: AUTH_UNCHECKED }, { status: 503 })
    for (const cookie of res.cookies.getAll()) unchecked.cookies.set(cookie)
    return unchecked
  }

  const url = request.nextUrl.clone()
  url.pathname = '/login'
  return NextResponse.redirect(url)
}

// The installable-app assets (#21) are skipped entirely, by name. Browsers fetch the manifest
// without credentials, so behind the login gate "Add to Home Screen" would receive a 307 to /login
// instead of a manifest and fail to install, even for a signed-in user. Named rather than every
// `.png`, and anchored at the root, so the exemption cannot quietly widen.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest\\.webmanifest$|(?:icon|apple-icon|apple-touch-icon)(?:-[\\w-]+)?\\.png$|.*\\.svg$).*)',
  ],
}
