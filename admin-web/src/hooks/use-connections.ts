import { useQuery } from '@tanstack/react-query'
import { listConnections } from '@/api/connections'

const REFRESH_MS = 3000

/**
 * Live observation of online SSE connections via 3s polling.
 * Connections are in-memory and change by the second, so polling is sufficient for the
 * admin view (no need to open a dedicated SSE for admin), and 3s puts no pressure on
 * the backend. Polling is paused on error to avoid thundering-herd retries.
 */
export function useConnections() {
  return useQuery({
    queryKey: ['admin', 'connections'],
    queryFn: listConnections,
    refetchInterval: (query) => (query.state.error ? false : REFRESH_MS),
    placeholderData: (prev) => prev,
  })
}
