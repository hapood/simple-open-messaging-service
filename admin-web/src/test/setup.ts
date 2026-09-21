import '@testing-library/jest-dom/vitest'

// Always install the in-memory storage — never trust the ambient one. Node ≥22 exposes a global
// localStorage that merely WARNS without --localstorage-file, so an availability check like
// `if (!window.localStorage)` can silently pass while the runtime storage is non-functional.
// Installing unconditionally makes the suite independent of the Node/jsdom runtime that runs it.
const values = new Map<string, string>()
const storage: Storage = {
  get length() {
    return values.size
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => {
    values.delete(key)
  },
  setItem: (key, value) => {
    values.set(key, String(value))
  },
}
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: storage,
})
