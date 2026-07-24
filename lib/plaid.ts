import 'server-only'
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'

// Fail fast on a bad PLAID_ENV rather than silently falling back to sandbox. The old
// exact-match test meant "Production", "prod", an unset value, or a trailing space all
// quietly selected the FAKE banks — and paired with production credentials that yields an
// auth error the UI never surfaces. On a Vercel typo there'd be no signal at all.
const env = process.env.PLAID_ENV
if (env !== 'sandbox' && env !== 'production') {
  throw new Error(
    `PLAID_ENV must be exactly "sandbox" or "production" (got ${JSON.stringify(env)}). ` +
      'Refusing to start rather than silently falling back to sandbox.'
  )
}

// Which environment an item belongs to. Stamped onto plaid_items at link time and filtered
// on every read, because all environments share one database (see migration 010).
export const plaidEnv: 'sandbox' | 'production' = env

const configuration = new Configuration({
  basePath: env === 'production' ? PlaidEnvironments.production : PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
      'PLAID-SECRET': process.env.PLAID_SECRET!,
      'Plaid-Version': '2020-09-14',
    },
  },
})

export const plaidClient = new PlaidApi(configuration)
