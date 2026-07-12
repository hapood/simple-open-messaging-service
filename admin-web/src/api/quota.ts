import { request } from '@/api/client'
import type { QuotaNode, QuotaOverrides } from '@/types/api'

/** List every quota node (the local server + each federated peer) with today's usage + limits. */
export function getQuotaNodes(): Promise<QuotaNode[]> {
  return request<QuotaNode[]>('/admin/quota/nodes')
}

/** Set a node's per-category overrides (a null field = use the global default). `domain` is a single
 *  path segment (dots are fine; never a slash). */
export function setQuotaNodeLimits(
  domain: string,
  overrides: QuotaOverrides,
): Promise<void> {
  return request<void>(
    `/admin/quota/nodes/${encodeURIComponent(domain)}`,
    overrides,
  )
}
