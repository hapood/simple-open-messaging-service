import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cleanMediaTemporary,
  listMediaDownloads,
  listMediaFiles,
  listMediaUploads,
  reclaimMediaFile,
  retryMediaDownload,
  retryMediaUpload,
  stopMediaDownload,
  stopMediaUpload,
  stopPhysicalDownload,
  type FileQuery,
  type MediaQuery,
} from '@/api/media';

export function useMediaFiles(query: FileQuery, temporary = false) {
  return useQuery({
    queryKey: ['admin', 'media', temporary ? 'temporary' : 'files', query],
    queryFn: () => listMediaFiles(query, temporary),
  });
}
export function useMediaUploads(query: MediaQuery) {
  return useQuery({
    queryKey: ['admin', 'media', 'uploads', query],
    queryFn: () => listMediaUploads(query),
    refetchInterval: 5000,
  });
}
export function useMediaDownloads(query: MediaQuery & { status?: string }) {
  return useQuery({
    queryKey: ['admin', 'media', 'downloads', query],
    queryFn: () => listMediaDownloads(query),
    refetchInterval: 5000,
  });
}

export type MediaCommand =
  | {
      kind: 'upload-stop' | 'upload-retry' | 'download-stop' | 'download-retry';
      id: string;
    }
  | { kind: 'reclaim' | 'physical-stop' | 'temporary-clean'; id: string };
const commands = {
  'upload-stop': stopMediaUpload,
  'upload-retry': retryMediaUpload,
  'download-stop': stopMediaDownload,
  'download-retry': retryMediaDownload,
  reclaim: reclaimMediaFile,
  'temporary-clean': cleanMediaTemporary,
  'physical-stop': stopPhysicalDownload,
};
export function useMediaCommand() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (command: MediaCommand) => commands[command.kind](command.id),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['admin', 'media'] });
      void client.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
    },
  });
}
