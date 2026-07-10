import { request } from '@/api/client'
import type { AuditListResult } from '@/types/api'

export interface AuditQuery {
  skip?: number
  take?: number
  action?: string
  adminId?: number
  success?: boolean
}

export function listAudit(q: AuditQuery): Promise<AuditListResult> {
  return request<AuditListResult>('/admin/audit', q)
}
