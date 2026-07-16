import { useQuery } from '@tanstack/react-query'
import { getPublicConfig } from '@/api/config'

/** Public site config (GET /config) — fetched once and shared. Drives client-side gating such as
 *  whether the create-user password field is shown/required. staleTime 5 min: the const is static for
 *  now; when it becomes DB-driven the natural TTL still bounds staleness. */
export function usePublicConfig() {
  return useQuery({
    queryKey: ['public', 'config'],
    queryFn: () => getPublicConfig(),
    staleTime: 5 * 60 * 1000,
  })
}
