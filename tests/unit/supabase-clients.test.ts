import { describe, expect, it, vi } from 'vitest'

// The two server-side Supabase clients are built with the read limit (#202). What the limit does is in
// tests/unit/read-deadline.test.ts. proxy.ts builds a third, which only asks Supabase Auth, so it has
// nothing the limit applies to.
const { createServerClient, createAdminClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(() => ({})),
  createAdminClient: vi.fn(() => ({})),
}))

vi.mock('@supabase/ssr', () => ({ createServerClient }))
vi.mock('@supabase/supabase-js', () => ({ createClient: createAdminClient }))
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }))

import { fetchWithReadDeadline } from '@/lib/supabase/read-deadline'
import { createClient } from '@/lib/supabase/server'
import '@/lib/supabase/admin'

describe('the server-side Supabase clients (#202)', () => {
  it("gives the pages' client the read limit", async () => {
    await createClient()
    expect(createServerClient).toHaveBeenCalledTimes(1)
    expect(createServerClient.mock.calls[0]).toContainEqual(
      expect.objectContaining({ global: { fetch: fetchWithReadDeadline } })
    )
  })

  it('gives the service-role client the read limit, and keeps it from storing a session', () => {
    expect(createAdminClient).toHaveBeenCalledTimes(1)
    expect(createAdminClient.mock.calls[0]).toContainEqual({
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: fetchWithReadDeadline },
    })
  })
})
