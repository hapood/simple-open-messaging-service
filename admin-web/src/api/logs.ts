import { request } from '@/api/client';
import type { LogRecord } from '@/hooks/use-log-stream';

export interface LogHistoryQuery {
  skip?: number;
  take?: number;
  /** Inclusive minimum level (the selected level + every more-severe level). */
  level?: string;
  /** Lower time bound, ms epoch. */
  from?: number;
  /** Upper time bound, ms epoch. */
  to?: number;
  /** Case-insensitive substring over msg + context. */
  search?: string;
  /** Exact structured log scope. */
  scope?: string;
  /** Exact structured task identifier. */
  taskId?: string;
}

export interface LogHistoryResult {
  list: LogRecord[];
  /** Match count within the scanned window (NOT absolute — see `truncated`). */
  total: number;
  /** True when LOG_HISTORY_SCAN_BYTES was hit; older matches exist beyond the window. */
  truncated: boolean;
}

/** POST /admin/logs/history — search rotated log files (newest-first) by level/time-range/substring. */
export function listHistory(
  params: LogHistoryQuery,
): Promise<LogHistoryResult> {
  return request<LogHistoryResult>('/admin/logs/history', params);
}
