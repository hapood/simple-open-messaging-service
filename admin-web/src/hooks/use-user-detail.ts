import { useQuery } from '@tanstack/react-query'
import { getUserDetail } from '@/api/users'

/** User 360° detail. `enabled` gates the call until an id is known (the route param is present). */
export function useUserDetail(id: number | null) {
  return useQuery({
    queryKey: ['admin', 'users', id, 'detail'],
    queryFn: () => getUserDetail(id!),
    enabled: id !== null,
  })
}
