import { useQuery } from '@tanstack/react-query'
import { getMe } from '@/api/me'

/**
 * Current admin identity. Mounted once by the TopBar (every protected page), so the query is shared
 * across the app via React Query's cache. Role changes (Phase 3 admin self-management) surface on the
 * next refetch; the backend enforces RBAC regardless, so this is for UI gating only.
 */
export function useMe() {
  return useQuery({ queryKey: ['admin', 'me'], queryFn: () => getMe() })
}

/** Convenience for gating SUPER_ADMIN-only UI. False until the identity loads — the backend enforces
 *  RBAC either way, so a brief hide during load is safe. */
export function useIsSuperAdmin(): boolean {
  const { data } = useMe()
  return data?.role === 'SUPER_ADMIN'
}
