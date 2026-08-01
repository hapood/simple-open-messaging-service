import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { catchError, tap, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import type { FastifyRequest } from 'fastify';
import { DatabaseService } from '../database/database.service.js';
import { adminActionLog } from '../database/schema.js';
import { ADMIN_AUDIT_KEY, type AdminAuditMetadata } from './audit.decorator.js';
import type { AdminPrincipal } from './admin-session.js';

type AdminRequest = FastifyRequest & { user?: AdminPrincipal };

/**
 * Global audit interceptor. For any handler tagged @Audit whose caller is an authenticated admin,
 * appends an AdminActionLog row capturing the outcome (success/error), identity (adminId + role),
 * target (action + targetType + targetId from the named path param), and origin (ip + userAgent +
 * route).
 *
 * Best-effort: the write is fire-and-forget (`void`) and swallows its own errors — auditing is
 * secondary to the operation it observes (mirrors federation.service.logEvent). Runs for ALL routes
 * but is a no-op unless the handler carries @Audit metadata AND req.user.adminId is set (an admin
 * request), so user-side traffic and the admin login endpoint incur no overhead.
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly database: DatabaseService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<
      AdminAuditMetadata | undefined
    >(ADMIN_AUDIT_KEY, [context.getHandler(), context.getClass()]);
    // Not an audited handler → pass through untouched (the common case; this interceptor is global).
    if (!meta) return next.handle();

    const req = context.switchToHttp().getRequest<AdminRequest>();
    const adminId = req.user?.adminId;
    // Non-admin caller (e.g. the login endpoint, or a user-route sharing the global interceptor) →
    // nothing meaningful to log.
    if (adminId === undefined) return next.handle();

    return next.handle().pipe(
      tap(() => {
        void this.record(req, adminId, meta, true);
      }),
      catchError((err: unknown) => {
        void this.record(req, adminId, meta, false, err);
        return throwError(() => err);
      }),
    );
  }

  private async record(
    req: AdminRequest,
    adminId: number,
    meta: AdminAuditMetadata,
    success: boolean,
    err?: unknown,
  ): Promise<void> {
    try {
      const params = req.params as Record<string, unknown> | undefined;
      const targetId = meta.options?.targetParam
        ? String(params?.[meta.options.targetParam] ?? '')
        : undefined;
      const ip = (req.ip ?? '').slice(0, 64);
      const ua = String(req.headers['user-agent'] ?? '').slice(0, 255);
      await this.database.db.insert(adminActionLog).values({
        adminId,
        adminRole: req.user!.role,
        action: meta.action,
        targetType: meta.options?.targetType,
        targetId: targetId || undefined,
        ip: ip || null,
        userAgent: ua || null,
        route: String(req.url ?? '').slice(0, 255),
        success,
        errorMessage: success
          ? null
          : (err instanceof Error ? err.message : String(err)).slice(0, 255),
      });
    } catch {
      // Swallow — audit is best-effort and must never break the observed operation.
    }
  }
}
