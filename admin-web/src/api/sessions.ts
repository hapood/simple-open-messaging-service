import { request } from '@/api/client'
import type { SessionListResult } from '@/types/api'

/** 全系统活跃会话总览（跨用户，可筛 userId/ip） */
export function listAllSessions(params: {
  skip?: number
  take?: number
  userId?: number
  ip?: string
}): Promise<SessionListResult> {
  return request<SessionListResult>('/admin/sessions', params)
}

/** 一键清理所有活跃会话（吊销 refresh + bump tokenVersion，强制全部用户重登） */
export function purgeAllSessions(): Promise<{ purgedUsers: number }> {
  return request<{ purgedUsers: number }>('/admin/sessions/purge')
}
