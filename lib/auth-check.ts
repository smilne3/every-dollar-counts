import { isAuthRetryableFetchError, type AuthError, type User, type UserResponse } from '@supabase/supabase-js'

// What one sign-in check found, by the rule PR #142 settled (04fd42b) and #143 carries to the proxy,
// the app's layout and the sign-in callback:
// - 'signed-in': Supabase Auth vouched for the session.
// - 'unknown': Supabase Auth could not be asked. auth-js reports that as an AuthRetryableFetchError:
//   no connection, or a 5xx from Supabase Auth. The session may well be fine, so the answer is "try
//   again", never anything that signs the person out. Read as signed out, a brief outage sent the
//   whole household to the login screen.
// - 'ended': every other answer, a null user included. No session, or one Supabase Auth refused,
//   such as an expired one whose refresh token is dead, which comes back as the refresh call's own
//   4xx (refresh_token_not_found, refresh_token_already_used, session_expired), not as a missing
//   session. "Try again" there would never succeed. Its error comes with it, for a caller to whom an
//   ended session is news worth logging (app/auth/confirm/route.ts).
export type SignIn =
  | { state: 'signed-in'; user: User }
  | { state: 'unknown'; error: AuthError }
  | { state: 'ended'; error: AuthError | null }

// getUser answers { user: null, error } on ANY auth failure, a dropped connection included, so only
// the error tells the two apart. A check that could not be made is logged here, under the caller's
// tag, so an outage can be told from real sign-outs afterwards. A sign-out is not logged: it is
// nothing unusual.
export async function checkSignIn(supabase: { auth: { getUser(): Promise<UserResponse> } }, tag: string): Promise<SignIn> {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (isAuthRetryableFetchError(error)) {
    console.error(`${tag} auth check failed`, { status: error.status, message: error.message })
    return { state: 'unknown', error }
  }
  return user ? { state: 'signed-in', user } : { state: 'ended', error }
}
