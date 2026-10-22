import { useQuery } from '@tanstack/react-query'
import { listGroups, type GroupsQuery } from '@/api/groups'

export function useGroups(q: GroupsQuery) {
  return useQuery({
    queryKey: ['admin', 'groups', q],
    queryFn: () => listGroups(q),
    placeholderData: (prev) => prev,
  })
}
