import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import { fileURLToPath } from 'node:url'

const emptyStub = fileURLToPath(new URL('./tests/stubs/empty.ts', import.meta.url))

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: {
      'server-only': emptyStub,
      'client-only': emptyStub,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    // lib/plaid.ts throws at import time unless PLAID_ENV is exactly 'sandbox' | 'production'.
    // Vitest does not read .env.local, so without this ANY test that imports something in that
    // module's chain (lib/sync, lib/ingest, the Plaid routes) dies with a message about
    // environment variables instead of about the code under test. Mirrors what CI already sets
    // for the build. Never 'production' here — tests must not be able to reach real banks.
    env: { PLAID_ENV: 'sandbox' },
  },
})
