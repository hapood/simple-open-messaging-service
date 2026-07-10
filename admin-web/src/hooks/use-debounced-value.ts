import { useEffect, useState } from 'react'

/**
 * Returns a debounced copy of `value`: it only updates after `value` has been
 * stable for `delay` ms. Used to defer search input → network fetches while the
 * user is still typing.
 *
 * Replaces the inline `useEffect` + `setTimeout` pattern that was copy-pasted
 * across the list pages. Callers that reset pagination when the search commits
 * should watch the returned value, e.g. `useEffect(() => setPage(0), [debounced])`.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}
