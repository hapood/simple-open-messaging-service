import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { deletePushToken, listPushTokens, sendPushTest } from '@/api/push'

export function usePushTokens(params: { skip?: number; take?: number; search?: string }) {
  return useQuery({
    queryKey: ['admin', 'push', 'tokens', params],
    queryFn: () => listPushTokens(params),
    placeholderData: (prev) => prev, // avoid a flash on pagination / search
  })
}

export function useDeletePushToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deletePushToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'push', 'tokens'] }),
  })
}

export function useSendPushTest() {
  return useMutation({
    mutationFn: (payload: { id: number; title: string; body?: string }) => sendPushTest(payload),
  })
}
