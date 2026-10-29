import { request } from '@/api/client';

export interface MediaUser {
  account: string;
  namespaceId: number;
}
export interface Page<T> {
  list: T[];
  total: number;
}
export interface MediaQuery {
  skip: number;
  take: number;
  userId?: number;
}
export interface FileQuery extends MediaQuery {
  digest?: string;
  status?: 'available' | 'reclaimed';
}
export interface MediaFile {
  digest: string;
  bytes: string;
  status: 'available' | 'reclaimed' | 'temporary';
  users: MediaUser[];
  userCount: number;
}
export interface MediaUpload {
  uploadId: string;
  userId: number;
  digest: string | null;
  bytes: string;
  bytesReceived: string;
  status: 'UPLOADING' | 'COMPLETING' | 'ABORTED';
}
export interface DownloadBatch {
  batchId: string;
  status: 'pending' | 'downloading' | 'failed' | 'ready';
  users: MediaUser[];
  totalFiles: number;
  completedFiles: number | null;
  bytesTotal: string | null;
  bytesReceived: string | null;
  files: {
    digest: string;
    status: string;
    bytesTotal: string;
    bytesReceived: string;
  }[];
}
export interface DownloaderSnapshot
  extends Page<{
    digest: string;
    status: 'queued' | 'active';
    bytesReceived: string;
    bytesTotal: string | null;
    users: MediaUser[];
    userCount: number;
  }> {
  instanceId: string;
  observedAt: string;
  limits: { global: number; perPeer: number };
  active: number;
  queued: number;
}

export const listMediaFiles = (query: FileQuery, temporary = false) =>
  request<Page<MediaFile> & { bytes: string }>(
    temporary ? '/admin/media/temporary' : '/admin/media/files',
    query,
  );
export const listMediaUploads = (query: MediaQuery) =>
  request<Page<MediaUpload> & { bytes: string }>('/admin/media/uploads', query);
export const listMediaDownloads = (query: MediaQuery & { status?: string }) =>
  request<Page<DownloadBatch>>('/admin/media/downloads', query);
export const stopMediaUpload = (id: string) =>
  request(`/admin/media/uploads/${id}/stop`);
export const stopMediaDownload = (id: string) =>
  request(`/admin/media/downloads/${id}/stop`);
export const retryMediaDownload = (id: string) =>
  request(`/admin/media/downloads/${id}/retry`);
export const cleanMediaDownload = (id: string) =>
  request(`/admin/media/downloads/${id}/clean`);
export const stopPhysicalDownload = (digest: string) =>
  request('/admin/media/downloader/stop', { digest });
export const cleanMediaTemporary = (digest: string) =>
  request('/admin/media/temporary/clean', { digest });
export const reclaimMediaFile = (digest: string) =>
  request('/admin/media/files/reclaim', { digest });
