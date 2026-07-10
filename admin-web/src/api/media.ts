import { request } from '@/api/client'
import type { MediaStats } from '@/types/api'

export interface GcResult {
  reapedRows: number
  reapedFiles: number
  sweptTmp: number
}

export function getMediaStats(): Promise<MediaStats> {
  return request<MediaStats>('/admin/media/stats')
}

export function triggerMediaGc(): Promise<GcResult> {
  return request<GcResult>('/admin/media/gc')
}

export function reconcileMedia(): Promise<{ reapedFiles: number }> {
  return request<{ reapedFiles: number }>('/admin/media/reconcile')
}

export function gcAvatars(): Promise<{ sweptFiles: number }> {
  return request<{ sweptFiles: number }>('/admin/media/gc-avatars')
}
