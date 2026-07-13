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
  },
})
