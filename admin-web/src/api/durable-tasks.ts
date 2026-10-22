import { request } from '@/api/client';
import type { DurableTaskListResult, DurableTaskStatus } from '@/types/api';

export interface DurableTaskQuery {
  skip?: number;
  take?: number;
  search?: string;
  status?: DurableTaskStatus;
}

export function listDurableTasks(
  q: DurableTaskQuery,
): Promise<DurableTaskListResult> {
  return request<DurableTaskListResult>('/admin/durable-tasks', q);
}
