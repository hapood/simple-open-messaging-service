import { useQuery } from '@tanstack/react-query'
import { globalSearch } from '@/api/search'
import { useDebouncedValue } from '@/hooks/use-debounced-value'

/** Debounced jump-target search for the ⌘K palette. Only fires once the query is non-blank. */
export function useGlobalSearch(input: string) {
  const q = useDebouncedValue(input, 200)
  return useQuery({
    queryKey: ['admin', 'search', q],
    queryFn: () => globalSearch(q.trim()),
    enabled: q.trim().length > 0,
    staleTime: 15_000,
  })
}
