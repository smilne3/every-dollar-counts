import { vi } from 'vitest'

// Node 25 defines a localStorage global of its own, which has no methods without
// --localstorage-file and shadows jsdom's in this suite (the same trap components/plaid-link-context.ts
// guards against at build time). Anything that keeps the pending Plaid link needs a working one, so
// this stands in for it. Undo with vi.unstubAllGlobals().
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
