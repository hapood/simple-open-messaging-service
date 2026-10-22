import { request } from '@/api/client';
import type { MediaStats } from '@/types/api';

export function getMediaStats(): Promise<MediaStats> {
  return request<MediaStats>('/admin/media/stats');
}

export interface ResumableUploadSession {
  uploadId: string;
  clientMessageId: string;
  creatorId: number;
  contentType: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';
  originalName: string;
  mimeType: string;
  totalBytes: number;
  offset: number;
  chunkSize: number;
  status: 'UPLOADING' | 'COMPLETING';
  updatedAt: number;
}

interface FederationDownloadFile {
  id: string;
  digest: string;
  kind: string;
  status: string;
  bytesTotal: string;
  bytesReceived: string;
  errorKind: string | null;
  updatedAt: string;
}

export interface FederationDownloadBatch {
  batchId: string;
  threadId: number;
  messageSeq: number;
  creator: { account: string; domain: string };
  originSeq: number | null;
  contentType: string;
  status: string;
  fileCnt: number;
  anyFailed: boolean;
  failReason: string | null;
  originDomain: string | null;
  updatedAt: string;
  files: FederationDownloadFile[];
}

export function listFederationDownloads(): Promise<{
  batches: FederationDownloadBatch[];
}> {
  return request('/admin/media/downloads');
}

export function retryFederationDownload(batchId: string) {
  return request<{ batchId: string; resetFiles: number }>(
    `/admin/media/downloads/${batchId}/retry`,
  );
}

export function cleanFederationDownload(batchId: string) {
  return request<{
    clearedBatch: boolean;
    clearedDependents: number;
    fileRows: number;
  }>(`/admin/media/downloads/${batchId}/clean`);
}

export function listResumableUploads(): Promise<ResumableUploadSession[]> {
  return request<ResumableUploadSession[]>('/admin/media/uploads');
}

export function abortResumableUpload(
  uploadId: string,
): Promise<{ uploadId: string; status: 'ABORTED' }> {
  return request<{ uploadId: string; status: 'ABORTED' }>(
    `/admin/media/uploads/${uploadId}/abort`,
  );
}
