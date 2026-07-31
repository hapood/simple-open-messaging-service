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

export function triggerMediaGc(): Promise<GcResult> {
  return request<GcResult>('/admin/media/gc');
}

export function reconcileMedia(): Promise<{ reapedFiles: number }> {
  return request<{ reapedFiles: number }>('/admin/media/reconcile');
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
