import { request } from '@/api/client'
import type { DashboardSummary } from '@/types/api'

/** Console overview: online / sessions / federation / media / recent admin actions. */
export function getDashboard(): Promise<DashboardSummary> {
  return request<DashboardSummary>('/admin/dashboard')
}
