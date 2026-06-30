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
    // 翻页/搜索时保留旧数据防闪烁
    placeholderData: (prev) => prev,
  })
}
