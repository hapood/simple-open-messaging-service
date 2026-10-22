import { request } from '@/api/client'
import type { GroupListResult } from '@/types/api'

export interface GroupsQuery {
  skip?: number
  take?: number
  search?: string
}

export function listGroups(q: GroupsQuery): Promise<GroupListResult> {
  return request<GroupListResult>('/admin/groups', q)
}
