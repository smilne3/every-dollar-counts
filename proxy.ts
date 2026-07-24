import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

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

  // IMPORTANT: no code between createServerClient and getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser()

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
  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return res
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)'],
}
