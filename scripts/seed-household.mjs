// Creates a household and invites the first member (sends them a magic login link).
// Run AFTER the db/migrations SQL has been applied.
// Usage: node --env-file=.env.local scripts/seed-household.mjs <email> "<household name>" [siteUrl]
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const email = process.argv[2]
const name = process.argv[3] || 'Our Household'
const site = process.argv[4] || 'http://localhost:3000'

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (use --env-file=.env.local)')
  process.exit(1)
}
if (!email) {
  console.error('Usage: node --env-file=.env.local scripts/seed-household.mjs <email> "<household name>" [siteUrl]')
  process.exit(1)
}

const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

const { data: h, error: he } = await admin.from('households').insert({ name }).select('id').single()
if (he) { console.error('household insert failed:', he.message); process.exit(1) }

let userId
const { data: created, error: ce } = await admin.auth.admin.createUser({
  email,
  email_confirm: true, // confirmed, so they can sign in with a magic link right away
})
if (ce) {
  const { data: list } = await admin.auth.admin.listUsers()
  const found = list?.users.find((x) => x.email?.toLowerCase() === email.toLowerCase())
  if (!found) { console.error('createUser failed:', ce.message); process.exit(1) }
  userId = found.id
  console.log('(user already existed — linking to the new household)')
} else {
  userId = created.user.id
}

const { error: me } = await admin.from('memberships').insert({ user_id: userId, household_id: h.id })
if (me) { console.error('membership insert failed:', me.message); process.exit(1) }

console.log(`✓ Household "${name}" created (${h.id})`)
console.log(`✓ Account ready for ${email} — sign in at ${site} with a magic link.`)
