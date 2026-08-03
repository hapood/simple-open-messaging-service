import { request } from '@/api/client';
import type { MediaStats } from '@/types/api';

export interface GcResult {
  reapedRows: number;
  reapedFiles: number;
  sweptTmp: number;
}

export interface ForwardBundleGcResult {
  orphanBundles: number;
  orphanAssets: number;
  orphanBytes: string;
}

export function getMediaStats(): Promise<MediaStats> {
  return request<MediaStats>('/admin/media/stats');
}

export type MediaGcTaskKind = 'gc' | 'reconcile';
export type MediaGcTaskStatus =
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface MediaGcTask {
  id: string;
  kind: MediaGcTaskKind;
  status: MediaGcTaskStatus;
  phase: string;
  directory: string | null;
  file: string | null;
  fileSize: string | null;
  scannedFiles: number;
  scannedBytes: string;
  deletedFiles: number;
  deletedBytes: string;
  startedAt: string;
  finishedAt: string | null;
  result?: GcResult | ReconcileResult;
  error?: string;
}

export function triggerMediaGc(): Promise<MediaGcTask> {
  return request<MediaGcTask>('/admin/media/gc');
}

export interface ReconcileResult {
  deletedOrphanFiles: number;
  deletedTombstoneFiles: number;
  markedMissingReadyDeleted: number;
  skippedPending: number;
  skippedDeleting: number;
}

export interface PendingAsset {
  digest: string;
  bytes: string;
  stateChangedAt: string;
  pendingMediaCount: number;
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
  updatedAt: string;
}

export function reconcileMedia(): Promise<MediaGcTask> {
  return request<MediaGcTask>('/admin/media/reconcile');
}

export function cancelMediaTask(id: string): Promise<MediaGcTask> {
  return request<MediaGcTask>(`/admin/media/tasks/${id}/cancel`);
}

export function getCurrentMediaTask(): Promise<MediaGcTask | null> {
  return request<MediaGcTask | null>('/admin/media/tasks/current');
}

export function listPendingAssets(): Promise<PendingAsset[]> {
  return request<PendingAsset[]>('/admin/media/pending/list');
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

export function forceTerminatePending(digest: string) {
  return request<{ terminated: boolean; busy: boolean }>(
    '/admin/media/pending/force-terminate',
    { digest },
  );
}

export function gcAvatars(): Promise<{ sweptFiles: number }> {
  return request<{ sweptFiles: number }>('/admin/media/gc-avatars');
}

export function inspectForwardBundles(): Promise<ForwardBundleGcResult> {
  return request<ForwardBundleGcResult>('/admin/media/forward-bundles/inspect');
}

export function gcForwardBundles(): Promise<ForwardBundleGcResult> {
  return request<ForwardBundleGcResult>('/admin/media/forward-bundles/gc');
}
