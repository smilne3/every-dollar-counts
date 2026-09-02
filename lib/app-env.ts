import 'server-only'
import { NextResponse } from 'next/server'
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

// The read currently in flight, so a cold start that serves several guarded requests at once
// issues ONE app_env query rather than one per request. Cleared as soon as it settles, which is
// what keeps a FAILED read uncached (see above) while still deduplicating a successful one.
let inFlightRead: Promise<Env> | null = null

async function readDatabaseEnv(): Promise<Env> {
  const { data, error } = await supabaseAdmin.from('app_env').select('plaid_env').maybeSingle()

  if (error) throw new Error(`could not read app_env: ${error.message}`)
  // Fail closed. A missing row is not "unconfigured, carry on" -- it is the one condition this
  // table exists to rule out, so it must stop writes rather than wave them through.
  if (!data) throw new Error('app_env has no row: run db/migrations/017_app_env.sql')

  cachedDatabaseEnv = data.plaid_env as Env
  return cachedDatabaseEnv
}

async function databaseEnv(): Promise<Env> {
  if (cachedDatabaseEnv) return cachedDatabaseEnv
  if (!inFlightRead) {
    inFlightRead = readDatabaseEnv().finally(() => {
      inFlightRead = null
    })
  }
  return inFlightRead
}

// Call before writing any household financial data. Resolves if this app may write here.
export async function assertEnvMatchesDatabase(): Promise<void> {
  const dbEnv = await databaseEnv()
  if (dbEnv !== plaidEnv) throw new EnvMismatchError(plaidEnv, dbEnv)
}

// The one answer every guarded route gives, so the 409/500 split is decided in ONE place. Four
// routes need it; four hand-rolled copies of the same try/catch had already started to drift
// (one logged `e.message`, another the whole error), and the split is the load-bearing part:
// 409 means "you are pointed at the wrong database", 500 means "the check itself could not run".
export function envGuardResponse(
  e: unknown,
  opts: { tag: string; mismatch: string; unreadable: string }
): NextResponse {
  if (e instanceof EnvMismatchError) {
    console.error(`${opts.tag} refusing to write across environments`, e.message)
    return NextResponse.json({ error: opts.mismatch }, { status: 409 })
  }
  console.error(`${opts.tag} environment guard could not run`, e)
  return NextResponse.json({ error: opts.unreadable }, { status: 500 })
}
