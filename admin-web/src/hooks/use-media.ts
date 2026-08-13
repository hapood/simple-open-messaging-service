import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  gcAvatars,
  gcForwardBundles,
  getMediaStats,
  inspectForwardBundles,
  listPendingAssets,
  forceTerminatePending,
  reconcileMedia,
  triggerMediaGc,
  cancelMediaTask,
  getCurrentMediaTask,
  listResumableUploads,
  abortResumableUpload,
  listPendingFederatedDeletions,
  type MediaGcTask,
} from '@/api/media';
import { API_BASE } from '@/lib/constants';
import { forceLogout } from '@/auth/force-logout';
import { readFrames } from '@/hooks/use-log-stream';

/** Invalidate media stats + the dashboard (which also shows media bytes) after a GC run. */
function useInvalidateMedia() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['admin', 'media'] });
    qc.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
  };
}

export function useMediaStats() {
  return useQuery({
    queryKey: ['admin', 'media', 'stats'],
    queryFn: () => getMediaStats(),
  });
}

export function usePendingAssets(enabled = true) {
  return useQuery({
    queryKey: ['admin', 'media', 'pending'],
    queryFn: listPendingAssets,
    enabled,
  });
}

export function useResumableUploads(enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'media', 'uploads'],
    queryFn: listResumableUploads,
    enabled,
    refetchInterval: enabled ? 5000 : false,
  });
}

export function usePendingFederatedDeletions(
  params: { skip: number; take: number },
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['admin', 'media', 'pending-federated-deletions', params],
    queryFn: () => listPendingFederatedDeletions(params),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useAbortResumableUpload() {
  const invalidate = useInvalidateMedia();
  return useMutation({
    mutationFn: abortResumableUpload,
    onSuccess: invalidate,
  });
}

export function useForceTerminatePending() {
  const invalidate = useInvalidateMedia();
  return useMutation({
    mutationFn: forceTerminatePending,
    onSuccess: invalidate,
  });
}

export function useTriggerMediaGc() {
  const invalidate = useInvalidateMedia();
  return useMutation({ mutationFn: triggerMediaGc, onSuccess: invalidate });
}

export function useReconcileMedia() {
  const invalidate = useInvalidateMedia();
  return useMutation({ mutationFn: reconcileMedia, onSuccess: invalidate });
}

export function useCancelMediaTask() {
  return useMutation({ mutationFn: cancelMediaTask });
}

export function useCurrentMediaTask(enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'media', 'task', 'current'],
    queryFn: getCurrentMediaTask,
    enabled,
    staleTime: 0,
  });
}

export function useMediaTaskProgress(taskId: string | null) {
  const [task, setTask] = useState<MediaGcTask | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!taskId) {
      setTask(null);
      setConnected(false);
      return;
    }
    let closed = false;
    let terminal = false;
    let aborter: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async (): Promise<void> => {
      aborter = new AbortController();
      try {
        const response = await fetch(
          `${API_BASE}/admin/media/tasks/${taskId}/progress`,
          {
            signal: aborter.signal,
            credentials: 'same-origin',
            headers: { Accept: 'text/event-stream' },
            cache: 'no-store',
          },
        );
        if (response.status === 401) {
          forceLogout();
          return;
        }
        if (!response.ok || !response.body)
          throw new Error(`SSE open failed: ${response.status}`);
        setConnected(true);
        await readFrames(response.body, (event, data) => {
          if (event === 'ping' || !data) return;
          if (!['progress', 'completed', 'cancelled', 'failed'].includes(event))
            return;
          terminal = ['completed', 'cancelled', 'failed'].includes(event);
          setTask(JSON.parse(data) as MediaGcTask);
        });
      } catch {
        // A short disconnect is recovered from the task's latest in-memory snapshot.
      } finally {
        setConnected(false);
        if (!closed && !terminal) {
          retry = setTimeout(() => void connect(), 1000);
        }
      }
    };
    void connect();
    return () => {
      closed = true;
      aborter?.abort();
      if (retry) clearTimeout(retry);
    };
  }, [taskId]);

  return { task, connected };
}

export function useGcAvatars() {
  const invalidate = useInvalidateMedia();
  return useMutation({ mutationFn: gcAvatars, onSuccess: invalidate });
}

export function useInspectForwardBundles() {
  return useMutation({ mutationFn: inspectForwardBundles });
}

export function useGcForwardBundles() {
  const invalidate = useInvalidateMedia();
  return useMutation({ mutationFn: gcForwardBundles, onSuccess: invalidate });
}
