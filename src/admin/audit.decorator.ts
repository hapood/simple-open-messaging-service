import { SetMetadata } from '@nestjs/common';
import type { AuditAction } from './audit-actions.js';

export interface AdminAuditOptions {
  /** Free-form target kind, e.g. 'user' | 'peer' | 'admin'. */
  targetType?: string;
  /** Route path-param whose value is recorded as targetId, e.g. 'id' | 'domain' | 'jti'. */
  targetParam?: string;
  /** Request-body fields recorded as a colon-separated target ID when no route parameter identifies it. */
  targetBody?: string | readonly string[];
}

export interface AdminAuditMetadata {
  action: AuditAction;
  options?: AdminAuditOptions;
}

export const ADMIN_AUDIT_KEY = 'admin:audit';

/**
 * Mark an admin handler for audit logging. AdminAuditInterceptor (registered globally) persists a
 * STARTED AdminActionLog row before the handler runs, then marks it SUCCEEDED or FAILED. If the first
 * write fails, the handler is not executed. Apply to every destructive admin action.
 */
export const Audit = (action: AuditAction, options?: AdminAuditOptions) =>
  SetMetadata(ADMIN_AUDIT_KEY, {
    action,
    options,
  } satisfies AdminAuditMetadata);
