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
    // TZ: date handling here has two failure modes that need OPPOSITE timezones to expose.
    // Reading local parts where UTC was meant (lib/budget.ts's isoDay) only shows east of UTC;
    // parsing a bare 'YYYY-MM-DD' through `new Date()`, which is UTC midnight, only shows west of
    // it. At UTC neither shows at all. So the default is east, and CI runs the suite a second
    // time with VITEST_TZ set west — see .github/workflows/ci.yml.
    env: { PLAID_ENV: 'sandbox', TZ: process.env.VITEST_TZ ?? 'Asia/Tokyo' },
  },
})
