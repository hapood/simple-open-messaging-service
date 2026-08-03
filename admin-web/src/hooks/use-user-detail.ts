import { useQuery } from '@tanstack/react-query'
import { getUserDetail } from '@/api/users'
import { getUserQuota, setUserQuota } from '@/api/users'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { QuotaOverrides } from '@/types/api'

/** User 360° detail. `enabled` gates the call until an id is known (the route param is present). */
export function useUserDetail(id: number | null) {
  return useQuery({
    queryKey: ['admin', 'users', id, 'detail'],
    queryFn: () => getUserDetail(id!),
    enabled: id !== null,
  })
}

export function useUserQuota(id: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'users', id, 'quota'],
    queryFn: () => getUserQuota(id!),
    enabled: id !== null && enabled,
  })
}

export function useSetUserQuota(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (overrides: QuotaOverrides) => setUserQuota(id, overrides),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users', id, 'quota'] }),
  })
}
