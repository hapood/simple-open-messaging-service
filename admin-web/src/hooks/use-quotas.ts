import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getQuotaNodes, setQuotaNodeLimits } from '@/api/quota'
import type { QuotaOverrides } from '@/types/api'

/** Invalidate the quota nodes list (a set-limits mutation refetches it). */
function useInvalidateQuotas() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['admin', 'quota'] })
}

export function useQuotaNodes() {
  return useQuery({
    queryKey: ['admin', 'quota', 'nodes'],
    queryFn: () => getQuotaNodes(),
  })
}

export function useSetQuotaNodeLimits() {
  const invalidate = useInvalidateQuotas()
  return useMutation({
    mutationFn: (v: { domain: string; overrides: QuotaOverrides }) =>
      setQuotaNodeLimits(v.domain, v.overrides),
    onSuccess: invalidate,
  })
}
