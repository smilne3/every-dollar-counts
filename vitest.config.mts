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
    // PLAID_ENV: lib/plaid.ts throws at import time unless this is exactly 'sandbox' |
    // 'production'. Vitest does not read .env.local, so without it ANY test importing that
    // module's chain (lib/sync, lib/ingest, the Plaid routes) dies with a message about
    // environment variables instead of about the code under test. Mirrors what CI already sets
    // for the build. Never 'production' here — tests must not be able to reach real banks.
    //
    // TZ: the window helpers in lib/budget.ts read LOCAL date parts on purpose, so the date a
    // card is labelled with can never disagree with the dates its rows were filtered by. At UTC
    // that choice is untestable — `new Date(2026, 8, 2)` and its toISOString() slice are the same
    // string — so the suite runs east of UTC, where a local-vs-UTC slip actually fails.
    env: { PLAID_ENV: 'sandbox', TZ: 'Asia/Tokyo' },
  },
})
