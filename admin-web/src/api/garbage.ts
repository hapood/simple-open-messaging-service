import { request } from '@/api/client';

export interface GarbageEntry {
  token: string;
  root: 'resumable' | 'cas';
  kind: 'upload' | 'download' | 'unknown' | 'directory';
  name: string;
  files: string[];
  bytes: string | null;
  modifiedAt: string;
  tasks: { id: string; status: string }[];
  canDelete: boolean;
  blockedReason: 'unsupported-entry' | null;
}
export interface GarbageScan {
  list: GarbageEntry[];
  total: number;
  limit: number;
}
export const scanGarbage = () => request<GarbageScan>('/admin/garbage/scan');
export const cleanGarbage = (token: string, confirmDirectory: boolean) =>
  request<{ cleaned: boolean }>('/admin/garbage/clean', {
    token,
    confirmDirectory,
  });
