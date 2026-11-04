import { describe, expect, it, vi } from 'vitest'

// The service-role client acts for no one, so it must never store or refresh a session of its own.
// lib/supabase/admin.ts was rewritten for the read limit (#202), so this holds the rest of its options.
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn(() => ({})) }))
vi.mock('@supabase/supabase-js', () => ({ createClient }))

import '@/lib/supabase/admin'

describe('the service-role client', () => {
  it("keeps no session: it doesn't store or refresh one", () => {
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(createClient.mock.calls[0]).toContainEqual(
      expect.objectContaining({ auth: { autoRefreshToken: false, persistSession: false } })
    )
  })
})
