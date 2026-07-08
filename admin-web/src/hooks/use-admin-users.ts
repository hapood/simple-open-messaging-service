import { useQuery } from '@tanstack/react-query'
import { listUsers } from '@/api/users'

export interface UsersQuery {
  skip: number
  take: number
  search?: string
}

export function useAdminUsers(q: UsersQuery) {
  return useQuery({
    queryKey: ['admin', 'users', q],
    queryFn: () => listUsers(q),
    // Keep previous data during paging/search to avoid flicker.
    placeholderData: (prev) => prev,
  })
}
