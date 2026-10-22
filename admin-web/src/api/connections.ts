import { request } from '@/api/client'
import type { ConnectionSnapshot } from '@/types/api'

/** Overview of currently online SSE connections (aggregated by user, read-only; in-memory, changes with connections). */
export function listConnections(): Promise<ConnectionSnapshot> {
  return request<ConnectionSnapshot>('/admin/connections')
}
