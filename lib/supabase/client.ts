import {
  clearAuthCookiesAtScopes,
  createBrowserClient,
  parseCookieHeader,
  serializeCookieHeader,
} from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  )
}

// Clears this browser's session cookie, for when signOut leaves it (components/SignOutButton.tsx):
// sb-<project ref>-auth-token, the name supabase-js gives it, with the .0, .1 … chunks @supabase/ssr
// splits a long one into, at /, where every client in this app writes it.
export async function clearSessionCookie() {
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]
  await clearAuthCookiesAtScopes({
    getAll: () => parseCookieHeader(document.cookie),
    setAll: (cookies) => {
      for (const { name, value, options } of cookies) document.cookie = serializeCookieHeader(name, value, options)
    },
    storageKey: `sb-${ref}-auth-token`,
    scopes: [{ path: '/' }],
  })
}
