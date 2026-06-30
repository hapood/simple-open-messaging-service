import { request } from '@/api/client'
import type { ReuseAlert } from '@/types/api'

export function reuseAlerts(take = 50): Promise<ReuseAlert[]> {
  return request<ReuseAlert[]>('/admin/reuse-alerts', { take })
}
