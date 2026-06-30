import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { listBans, unban } from '@/api/bans'

export function useBans() {
  return useQuery({ queryKey: ['admin', 'bans'], queryFn: listBans })
}

export function useUnban() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: { ip?: string; uniqName?: string }) => unban(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'bans'] }),
  })
}
