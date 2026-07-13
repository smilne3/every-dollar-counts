import 'server-only'
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'

const configuration = new Configuration({
  basePath:
    process.env.PLAID_ENV === 'production'
      ? PlaidEnvironments.production
      : PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
      'PLAID-SECRET': process.env.PLAID_SECRET!,
      'Plaid-Version': '2020-09-14',
    },
  },
})

export const plaidClient = new PlaidApi(configuration)
