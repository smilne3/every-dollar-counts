import { vi } from 'vitest'

// A fresh, in-memory localStorage for one test, for anything that keeps the pending Plaid link, so
// one test's pending link never reaches the next. Node 25's own localStorage global, which has no
// methods without --localstorage-file and used to shadow jsdom's here (the same trap
// components/plaid-link-context.ts guards against at build time), is now off in the test workers
// (vitest.config.mts, #141). Undo with vi.unstubAllGlobals().
export function useMemoryStorage(): Storage {
  const data = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  }
  vi.stubGlobal('localStorage', storage)
  return storage
}
