import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { gcAvatars, getMediaStats, reconcileMedia, triggerMediaGc } from '@/api/media'

/** Invalidate media stats + the dashboard (which also shows media bytes) after a GC run. */
function useInvalidateMedia() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['admin', 'media'] })
    qc.invalidateQueries({ queryKey: ['admin', 'dashboard'] })
  }
}

export function useMediaStats() {
  return useQuery({ queryKey: ['admin', 'media', 'stats'], queryFn: () => getMediaStats() })
}

export function useTriggerMediaGc() {
  const invalidate = useInvalidateMedia()
  return useMutation({ mutationFn: triggerMediaGc, onSuccess: invalidate })
}

export function useReconcileMedia() {
  const invalidate = useInvalidateMedia()
  return useMutation({ mutationFn: reconcileMedia, onSuccess: invalidate })
}

export function useGcAvatars() {
  const invalidate = useInvalidateMedia()
  return useMutation({ mutationFn: gcAvatars, onSuccess: invalidate })
}
