import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  abortResumableUpload,
  cleanFederationDownload,
  getMediaStats,
  listFederationDownloads,
  listResumableUploads,
  retryFederationDownload,
} from '@/api/media';

function useInvalidateTransfers() {
  const client = useQueryClient();
  return () => {
    client.invalidateQueries({ queryKey: ['admin', 'media'] });
    client.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
  };
}

export function useMediaStats() {
  return useQuery({
    queryKey: ['admin', 'media', 'stats'],
    queryFn: getMediaStats,
  });
}

export function useFederationDownloads(enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'media', 'downloads'],
    queryFn: listFederationDownloads,
    enabled,
    refetchInterval: enabled ? 5000 : false,
  });
}

export function useRetryFederationDownload() {
  const invalidate = useInvalidateTransfers();
  return useMutation({
    mutationFn: retryFederationDownload,
    onSuccess: invalidate,
  });
}

export function useCleanFederationDownload() {
  const invalidate = useInvalidateTransfers();
  return useMutation({
    mutationFn: cleanFederationDownload,
    onSuccess: invalidate,
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

export function useAbortResumableUpload() {
  const invalidate = useInvalidateTransfers();
  return useMutation({
    mutationFn: abortResumableUpload,
    onSuccess: invalidate,
  });
}
