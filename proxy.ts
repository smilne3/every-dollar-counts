import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { checkSignIn } from '@/lib/auth-check'

// What an /api request is told when Supabase Auth cannot be asked (#143). The request went no
// further, so nothing was saved. Its control shows this as it stands, as it does a route's own
// { error } (lib/save-response.ts), and since it answers for every route, it names none of them.
const AUTH_UNCHECKED = "Couldn't check your sign-in, so that didn't go through. Please try again."

// What a page request gets instead: the words app/error.tsx uses. Served before the app is, so it
// is whole in itself, its styles inline in the app's colours. Try again reloads the page, which
// checks again. The address is never written into it.
const UNCHECKED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Every Dollar Counts</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:0 16px;background:#f4f6f3;color:#14231c;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{box-sizing:border-box;width:100%;max-width:24rem;padding:32px;text-align:center;background:#fff;border:1px solid #e6e9e3;border-radius:16px;box-shadow:0 1px 2px rgba(20,35,28,.05)}
h1{margin:0;font-size:18px;font-weight:600}
p{margin:8px 0 0;font-size:14px;color:#5f6b64}
a{display:inline-block;margin-top:16px;font-size:14px;font-weight:500;color:#0e9f6e;text-decoration:none}
</style>
</head>
<body>
<main>
<h1>Couldn't check your sign-in</h1>
<p>Something went wrong reaching the sign-in service. Try again, or come back in a moment.</p>
<a href="">Try again</a>
</main>
</body>
</html>
`

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
  // would be signed out by an outage. Nor can a page go on. app/(app)/layout.tsx would check again,
  // but a layout's check does not stop the page under it from running (Next's authentication guide),
  // and a session that cannot be refreshed reads as no one, which gets empty lists back rather than
  // an error (#46): Settings said "No banks connected yet." beside Connect a bank (#51). So both are
  // answered here: an /api request in the JSON its control shows, a page with a page that says so. A
  // client-side navigation that gets the page loads it in full (Next's router does that with any
  // reply that is not its own). Each carries any cookie the check refreshed before it failed:
  // Supabase has already rotated that refresh token, and the old one, sent again, is refused as
  // already used, which ends the session. An expired session gets here only after auth-js has spent
  // about 25 seconds retrying its refresh; cut short, a refresh that then landed would be lost too.
  if (signIn.state === 'unknown') {
    const unchecked = pathname.startsWith('/api/')
      ? NextResponse.json({ error: AUTH_UNCHECKED }, { status: 503 })
      : new NextResponse(UNCHECKED_PAGE, {
          status: 503,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        })
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
