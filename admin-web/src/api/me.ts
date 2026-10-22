import { request } from '@/api/client'
import type { MeResult } from '@/types/api'

/** Current admin identity (account + role) — drives the header chip + role-gated UI. */
export function getMe(): Promise<MeResult> {
  return request<MeResult>('/admin/me')
}
