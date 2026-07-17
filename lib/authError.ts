// Supabase reports some sign-in failures only in the URL fragment (#error_code=...),
// which never reaches the server — so the error page has to read it in the browser.
// signup_disabled = an account that isn't in the system tried to sign in while
// signups are off, i.e. an uninvited visitor. Nothing expired; a new link won't help.
export function isInviteOnlyRejection(hash: string): boolean {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  return params.get('error_code') === 'signup_disabled'
}
