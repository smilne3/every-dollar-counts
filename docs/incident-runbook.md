# Incident runbook — Every Dollar Counts

What to do if a credential leaks or a bank connection is compromised. Short on purpose: this is a
two-person household app run by one person, and the whole point is that these steps are known and
doable in minutes, not that they're elaborate.

## If a secret leaks (Plaid secret, Supabase service-role key, or the token encryption key)

Work top to bottom; each step is independent, so do whichever is relevant to what leaked.

1. **Plaid secret** — In the Plaid dashboard (Team Settings → Keys), rotate the production secret.
   Update `PLAID_SECRET` on Vercel (production) and redeploy.
2. **Supabase service-role key** — In Supabase (Project Settings → API), roll the `service_role`
   key. Update `SUPABASE_SERVICE_ROLE_KEY` on Vercel (production) and redeploy.
3. **`TOKEN_ENCRYPTION_KEY`** — This decrypts every stored Plaid access token, so rotating it
   invalidates them. Generate a new one (`openssl rand -hex 32`), set it on Vercel, redeploy, then
   **disconnect and re-link every bank** (the old encrypted tokens can no longer be decrypted).
4. **Revoke sessions** — In Supabase Auth, sign out all users so any stolen session cookie dies.

## If a bank connection itself is compromised or acting wrong

1. In the app's Settings, **Disconnect** the affected bank — this calls Plaid's `/item/remove` and
   deletes its accounts and transactions.
2. Re-link it fresh if you still want it connected.

## Where the secrets live (so you know what you're rotating)

- **Vercel → Project → Settings → Environment Variables** (Production scope): `PLAID_SECRET`,
  `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_ENCRYPTION_KEY`, `PLAID_CLIENT_ID`.
- No secret is ever in the repo (`npm run check:secrets` enforces this) or in the browser.

## Who to tell

It's a household app with two users (you and your partner). If bank data may have been exposed,
tell your partner, and if you believe Plaid-side data was involved, contact Plaid support.
