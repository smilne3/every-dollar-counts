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
   invalidates them. **Order matters, and it is the opposite of what you'd guess:**
   1. **Disconnect every bank first**, in the app's Settings, while the *old* key still works. This
      is the only moment the app can still decrypt the tokens, and therefore the only moment it can
      actually revoke the connections at Plaid.
   2. Then generate a new key (`openssl rand -hex 32`), set it on Vercel, and redeploy.
   3. Then re-link the banks.

   > Rotate-then-disconnect — the original order — guarantees the worst outcome: every stored token
   > becomes undecryptable, so Disconnect can no longer revoke anything at Plaid. In a real leak, the
   > attacker would hold the key to ciphertexts you can no longer revoke.

   **Cost warning:** re-linking spends unrefundable Plaid Item slots (10 lifetime on the Trial plan).
   Rotating this key with 6 banks linked costs 6 of them. Treat rotation as a real incident response,
   not routine hygiene — and check the slot count in Settings first.
4. **Revoke sessions** — In Supabase Auth, sign out all users so any stolen session cookie dies.

> **Prevention, do this before go-live:** back up `TOKEN_ENCRYPTION_KEY` to the password vault and
> confirm it matches the Vercel Production value. Losing the key (deleted variable, recreated
> project) is indistinguishable from a leak and just as unrecoverable — except that you'd also have
> no warning. `lib/crypto.ts` stores no key version in the ciphertext, so a two-key rollover isn't
> possible today without a schema change; prefixing the payload with a key id (`v1:iv:tag:data`) and
> letting `decrypt` fall back to `TOKEN_ENCRYPTION_KEY_OLD` is about ten lines, if rotation ever
> needs to be non-destructive.

## If a bank connection itself is compromised or acting wrong

1. **Try Reconnect first** if the bank is merely misbehaving rather than compromised. It reopens the
   bank's login in update mode, fixes most "stopped syncing" problems, and **costs no Item slot**.
2. If the connection is genuinely compromised, **Disconnect** it in Settings — this calls Plaid's
   `/item/remove` and deletes its accounts and transactions. If Disconnect reports an error, do not
   assume it worked: the connection is still live at Plaid until it confirms removal.
3. Re-link it fresh if you still want it connected — **this spends a new Item slot; the disconnected
   one is not refunded.**

## Where the secrets live (so you know what you're rotating)

- **Vercel → Project → Settings → Environment Variables** (Production scope): `PLAID_SECRET`,
  `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_ENCRYPTION_KEY`, `PLAID_CLIENT_ID`.
- No secret is ever in the repo (`npm run check:secrets` enforces this) or in the browser.

## Who to tell

It's a household app with two users (you and your partner). If bank data may have been exposed,
tell your partner, and if you believe Plaid-side data was involved, contact Plaid support.
