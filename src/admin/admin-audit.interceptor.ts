import {
  CallHandler,
  ExecutionContext,
  InternalServerErrorException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { catchError, concatMap, from, map, mergeMap, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import type { FastifyRequest } from 'fastify';
import { DatabaseService } from '../database/database.service.js';
import { adminActionLog } from '../database/schema.js';
import { ADMIN_AUDIT_KEY, type AdminAuditMetadata } from './audit.decorator.js';
import type { AdminPrincipal } from './admin-session.js';

type AdminRequest = FastifyRequest & { user?: AdminPrincipal };

/**
 * Global audit interceptor. For any handler tagged @Audit whose caller is an authenticated admin,
 * appends an AdminActionLog row capturing the lifecycle, identity (adminId + role),
 * target (action + targetType + targetId from the named path param), and origin (ip + userAgent +
 * route).
 *
 * The STARTED row is durable before the handler runs. If that insert fails, the action is refused: a
 * privileged mutation must not execute without an audit trail. The row is then updated to SUCCEEDED or
 * FAILED. An outcome-update failure is logged and leaves STARTED behind as an explicit unknown result,
 * which is safer than inventing a final outcome. Runs for ALL routes but is a no-op unless the handler
 * carries @Audit metadata AND req.user.adminId is set.
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AdminAuditInterceptor.name);

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

    return from(this.start(req, adminId, meta)).pipe(
      concatMap((auditId) =>
        next.handle().pipe(
          concatMap((value) =>
            from(this.finish(auditId, 'SUCCEEDED')).pipe(map(() => value)),
          ),
          catchError((err: unknown) =>
            from(this.finish(auditId, 'FAILED', err)).pipe(
              mergeMap(() => throwError(() => err)),
            ),
          ),
        ),
      ),
    );
  }

  private async start(
    req: AdminRequest,
    adminId: number,
    meta: AdminAuditMetadata,
  ): Promise<bigint> {
    try {
      const params = req.params as Record<string, unknown> | undefined;
      const body = req.body as Record<string, unknown> | undefined;
      const targetId = meta.options?.targetParam
        ? String(params?.[meta.options.targetParam] ?? '')
        : meta.options?.targetBody
          ? String(body?.[meta.options.targetBody] ?? '')
          : undefined;
      const ip = (req.ip ?? '').slice(0, 64);
      const ua = String(req.headers['user-agent'] ?? '').slice(0, 255);
      const [row] = await this.database.db
        .insert(adminActionLog)
        .values({
          adminId,
          adminRole: req.user!.role,
          action: meta.action,
          targetType: meta.options?.targetType,
          targetId: targetId || undefined,
          ip: ip || null,
          userAgent: ua || null,
          route: String(req.url ?? '').slice(0, 255),
          status: 'STARTED',
        })
        .returning({ id: adminActionLog.id });
      if (!row) throw new Error('audit insert returned no row');
      return row.id;
    } catch (error) {
      this.logger.error(
        `refusing admin action because its audit record could not be created: ${meta.action}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException('admin audit unavailable');
    }
  }

  private async finish(
    auditId: bigint,
    status: 'SUCCEEDED' | 'FAILED',
    err?: unknown,
  ): Promise<void> {
    try {
      const [row] = await this.database.db
        .update(adminActionLog)
        .set({
          status,
          errorMessage:
            status === 'FAILED'
              ? (err instanceof Error ? err.message : String(err)).slice(0, 255)
              : null,
        })
        .where(eq(adminActionLog.id, auditId))
        .returning({ id: adminActionLog.id });
      if (!row) throw new Error('audit update returned no row');
    } catch (error) {
      this.logger.error(
        `admin audit ${auditId.toString()} could not be finalized as ${status}; it remains STARTED`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
