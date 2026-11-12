import { request } from '@/api/client';

export type AuditStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED';
export interface AuditRecord {
  id: string;
  adminId: number;
  adminRole: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  status: AuditStatus;
  createdAt: number;
  ip: string | null;
  userAgent: string | null;
  route: string | null;
  errorMessage: string | null;
}
export interface AuditDetail extends AuditRecord {
  updatedAt: number;
  meta: Record<string, unknown>;
}
export interface AuditQuery {
  skip: number;
  take: number;
  action?: string;
  adminId?: number;
  status?: AuditStatus;
  from?: string;
  to?: string;
}
export const listAudit = (query: AuditQuery) =>
  request<{ list: AuditRecord[]; total: number }>('/admin/audit', query);
export const getAuditDetail = (id: string) =>
  request<AuditDetail>('/admin/audit/detail', { id });
export const getAuditActions = () =>
  request<{ actions: string[] }>('/admin/audit/actions', {});
