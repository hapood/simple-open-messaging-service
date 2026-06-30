import { useQuery } from '@tanstack/react-query'
import { listConnections } from '@/api/connections'

const REFRESH_MS = 3000

/**
 * 在线 SSE 连接实时观测：3s 轮询。
 * 连接是内存态、秒级变化，admin 观测页用轮询足够（无需再为 admin 开一条 SSE），
 * 且 3s 不会给后端造成压力。出错时暂停轮询，避免雪崩。
 */
export function useConnections() {
  return useQuery({
    queryKey: ['admin', 'connections'],
    queryFn: listConnections,
    refetchInterval: (query) => (query.state.error ? false : REFRESH_MS),
    placeholderData: (prev) => prev,
  })
}
