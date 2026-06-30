import { request } from '@/api/client'
import type { ConnectionSnapshot } from '@/types/api'

/** 当前在线 SSE 连接总览（按用户聚合，只读；内存态，随连接变化） */
export function listConnections(): Promise<ConnectionSnapshot> {
  return request<ConnectionSnapshot>('/admin/connections')
}
