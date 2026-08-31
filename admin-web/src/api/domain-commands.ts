import { request } from '@/api/client';
import type { DomainCommandListResult, DomainCommandStatus } from '@/types/api';

export interface DomainCommandQuery {
  skip?: number;
  take?: number;
  search?: string;
  status?: DomainCommandStatus;
}

export function listDomainCommands(
  q: DomainCommandQuery,
): Promise<DomainCommandListResult> {
  return request<DomainCommandListResult>('/admin/domain-commands', q);
}
