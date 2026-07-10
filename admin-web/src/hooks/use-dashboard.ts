import { useQuery } from '@tanstack/react-query'
import { getDashboard } from '@/api/dashboard'

/**
 * Console overview. Polled every 15s — every underlying metric is a cheap read (SSE snapshot is
 * in-memory; the rest are counts/aggregates), so a slow refresh keeps the tiles live-ish without
 * hammering the DB. Pauses on error so a failing endpoint doesn't retry-spam.
 */
export function useDashboard() {
  return useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: () => getDashboard(),
    refetchInterval: (q) => (q.state.error ? false : 15_000),
    placeholderData: (prev) => prev,
  })
}
