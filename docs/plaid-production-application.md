# Plaid Production application — draft answers

**Purpose:** get Every Dollar Counts approved for full Production on the Pay-as-you-go plan, which
is what unlocks OAuth banks (Chase, Bank of America, Wells Fargo, Capital One, Citi).

**Submit this early.** Plaid's review is the long pole; the code is being built against sandbox in
parallel and doesn't depend on approval. See §3 of
`docs/superpowers/specs/2026-07-14-plaid-production-design.md`.

> **How to use this document:** the answers below are drafted from what this app actually does — I
> read the code to write them. Anything marked **⚠️ CONFIRM** is something I can't verify from the
> repo and you must check before submitting. Do not submit a claim you haven't confirmed; an
> inaccurate security questionnaire is worse than a modest one.

---

## The honest framing

You are a solo developer running a personal, two-person household app. Plaid knows this happens and
does not expect a hobbyist to have a bank's security program. Several questions below have no
respectable answer other than "not applicable — no employees," and that is fine. **Answer plainly.**
The instinct to dress it up is the thing to resist.

What genuinely helps you: the app has a real security story (encrypted tokens, row-level security,
no secrets in the browser, CI on every change). Say so precisely, and don't inflate the rest.

---

## Part 0 — What Plaid asks for besides the questionnaire

1. **Application display information** — the name and logo shown on the bank's consent screen.
   Use "Every Dollar Counts."
2. **Company information** — you're an individual, not a company. Answer as an individual /
   sole proprietor. **⚠️ CONFIRM** how Plaid wants this framed if the form insists on a company name.
3. **Master Services Agreement** — read and accept.
4. **Security questionnaire** — below.

---

## Part One

**1. Hosting.** Fully cloud-hosted on managed platforms; no on-premise or self-managed servers.
Application runs on Vercel (serverless functions, US region). Database is Supabase (managed
Postgres). Third-party data provider is Plaid.

**2. Governance — documented information security policy.** No formal written policy; this is a
personal project maintained by one person with no employees. Security practices are enforced
technically rather than by policy document: row-level security in the database, encrypted
credentials, a public repo with no secrets in it, and CI that fails the build if a secret is ever
referenced from client code.

**3. Asset management.** A single personal laptop (macOS) and three managed cloud accounts (GitHub,
Vercel, Supabase). No corporate network, no servers, no other endpoints.

**4. Vulnerability management.** Dependencies are managed via npm; the project builds on Node 22
with a locked dependency tree (`package-lock.json`). **⚠️ CONFIRM / DO:** enable GitHub Dependabot
alerts + security updates on the repo before submitting — it's two clicks, it's free, and it turns
this from a weak answer into a true one.

**5. Malicious code protection.** macOS with built-in protections (XProtect / Gatekeeper).
**⚠️ CONFIRM:** FileVault disk encryption is on.

**6. Personal devices (BYOD).** The developer's personal laptop is the only device. No employees,
so no BYOD policy is applicable. Production data is never copied to the laptop — local development
runs exclusively against Plaid's sandbox (fake banks, fake transactions), enforced by keeping
production Plaid credentials on Vercel production only.

**7. Access controls.** One person has access to everything; there is no one to grant or revoke
access for. Access to production consists of the GitHub, Vercel, Supabase, and Plaid dashboard
accounts.

**8. Authentication — strong factors (2FA) for critical assets. ⚠️ CONFIRM / DO:** turn on 2FA for
**all four** of GitHub, Vercel, Supabase, and the Plaid dashboard before submitting. These four
accounts are the entire attack surface for the app's credentials, so this is the single highest-value
item on this list — do it even if it delays the submission by an hour.

---

## Part Two

**9. Change controls.** All changes go through GitHub pull requests to a `main` branch. Merging to
`main` triggers an automatic Vercel deployment to production. No one deploys by hand or edits
production directly.

**10. Change testing.** Continuous integration runs on **every pull request and every push to
main**, and must pass before merge: TypeScript typecheck, ESLint, the Vitest unit test suite, a
production build, and a custom check that fails the build if a secret is ever exposed to the browser
(`npm run check:secrets`). See `.github/workflows/ci.yml`.

**11. Code reviews.** Every change lands via pull request with CI gating the merge. Being a solo
project, there is no second human reviewer — state this plainly rather than implying one exists.

**12. Encryption in transit.** TLS 1.2+ everywhere, enforced by the platforms rather than optional:
Vercel serves the app over HTTPS only, Supabase requires TLS for all database and API connections,
and all Plaid API calls are HTTPS.

**13. Encryption at rest.** Two layers:
- The **Plaid access token** is encrypted by the application with **AES-256-GCM** before it is
  written to the database (`lib/crypto.ts`), with the key held only in a server-side environment
  variable. It is stored in a table with row-level security enabled and **no client policy at all**,
  meaning it is unreachable from the browser under any user session — only server-side code holding
  the service-role key can read it.
- Supabase encrypts the underlying database volume at rest (AES-256).

**14. Audit trails.** Vercel retains function invocation and deployment logs; Supabase retains
database and auth logs; GitHub retains the full change history and who merged what.

**15. Monitoring and alerting.** Vercel surfaces runtime errors and failed deployments. Be honest:
there is no dedicated security monitoring or real-time alerting stack. **⚠️ CONFIRM:** that Vercel
deployment/error notifications are actually turned on for your account, or say you have none.

---

## Part Three

**16. Incident management.** No formal process today. **DO THIS:** write down a five-line runbook
before submitting, so this answer is true — what you'd do if a credential leaked. It's genuinely
short: rotate the Plaid secret in the Plaid dashboard, rotate `TOKEN_ENCRYPTION_KEY` and re-link
banks, rotate the Supabase service-role key, call Plaid's `/item/remove` on every linked bank, and
revoke sessions. Having written that down is the difference between "no process" and "yes, here it is."

**17. Network segmentation.** Not applicable in the traditional sense — there is no network to
segment. The security boundary is enforced differently and more strictly: the database's row-level
security scopes every table to a household, the service-role key that bypasses RLS exists only in
server-side environment variables and is never sent to the browser, and there is no client-side API
for the browser to fetch its own data with.

**18. Security awareness training.** Not applicable — no employees or contractors.

**19. Vendor management.** Three vendors, all SOC 2 compliant, all selected deliberately: Vercel
(hosting), Supabase (database and auth), Plaid (bank data). No other third parties receive any data.

**20. Independent testing.** None — no external audit or penetration test has been performed. Say so.

**21. HR screening.** Not applicable — no employees or contractors.

**22. Consumer consent.** The only two users are the two adult members of the household, who are the
account owners themselves. Bank connections are established through Plaid Link, which presents
Plaid's own consent screen; the app never sees or handles bank credentials. Signups are disabled
entirely — access is invite-only against an email allowlist.

**23. Data retention and deletion.** Disconnecting a bank calls Plaid's `/item/remove` and deletes
the connection, its accounts, and its transactions from the database. **⚠️ NOTE:** this feature is
being built as part of the current work (issue #11) — if you submit before it ships, describe it as
planned, not as existing.

**24. Data usage.** Data is never sold, shared, monetized, or transmitted to any third party. It is
used solely to display the household's own financial information back to the two people who own it.
There is no analytics, no advertising, and no other consumer of the data.

**25. 2FA on the client-facing application.** Sign-in is passwordless: Google SSO (which inherits
the 2FA on the user's Google account) or a one-time magic link to a pre-approved email address.
There are no passwords to steal, and signups are closed — an email must be on the allowlist to get
in at all.

---

## Before you hit submit

Four things, in priority order:

1. **Turn on 2FA** for GitHub, Vercel, Supabase, and Plaid. (Q8)
2. **Enable Dependabot** on the repo. (Q4)
3. **Write the five-line incident runbook.** (Q16)
4. **Confirm FileVault is on** and decide how you're answering the company-vs-individual question. (Q5, Part 0)

The first three each turn a weak answer into an honest strong one, and together they're maybe
thirty minutes of work.
