import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { plaidEnv } from '@/lib/plaid'

type Env = 'sandbox' | 'production'

// Thrown ONLY when the app and the database belong to different Plaid environments. Callers
// distinguish this from a plain Error to answer 409 (you are pointed at the wrong database)
// rather than 500 (something is broken).
export class EnvMismatchError extends Error {
  constructor(
    readonly appEnv: Env,
    readonly databaseEnv: Env
  ) {
    super(
      `This app is running in "${appEnv}" but the database belongs to "${databaseEnv}". ` +
        'Refusing to write bank data across environments.'
    )
    this.name = 'EnvMismatchError'
  }
}

// Memoised because the database cannot change identity under a running process. ONLY a
// successful read is cached: caching a failure would turn one transient blip into a permanent
// outage, since every guarded write fails closed.
let cachedDatabaseEnv: Env | null = null

async function databaseEnv(): Promise<Env> {
  if (cachedDatabaseEnv) return cachedDatabaseEnv

  const { data, error } = await supabaseAdmin.from('app_env').select('plaid_env').maybeSingle()

  if (error) throw new Error(`could not read app_env: ${error.message}`)
  // Fail closed. A missing row is not "unconfigured, carry on" -- it is the one condition this
  // table exists to rule out, so it must stop writes rather than wave them through.
  if (!data) throw new Error('app_env has no row: run db/migrations/017_app_env.sql')

  cachedDatabaseEnv = data.plaid_env as Env
  return cachedDatabaseEnv
}

// Call before writing any household financial data. Resolves if this app may write here.
export async function assertEnvMatchesDatabase(): Promise<void> {
  const dbEnv = await databaseEnv()
  if (dbEnv !== plaidEnv) throw new EnvMismatchError(plaidEnv, dbEnv)
}
