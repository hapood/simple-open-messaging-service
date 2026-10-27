import { Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  account,
  adminActionLog,
  durableTask,
  identityNamespace,
  mediaAsset,
  pendingMedia,
  sessionToken,
  uploadSession,
} from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';
import { AuditTargetLabelService } from './audit-target-label.service.js';

/**
 * Console overview aggregator. Every metric is a cheap read so the dashboard can poll:
 *  - online: the in-memory SSE connection snapshot (live downlinks, aggregated per user).
 *  - totalUsers: total registered local user accounts.
 *  - activeSessions: active user session tokens (unrevoked, not past their sliding deadline).
 *  - federation: peer counts grouped by trustLevel (excluding the local namespace id=0).
 *  - media: total content bytes + asset count from MediaAsset.
 *  - tasks: durable task queue breakdown (processing, pending, failed).
 *  - transfers: active resumable uploads and inbound federation downloads.
 *  - recentActions: the last 10 AdminActionLog rows (written by AdminAuditInterceptor).
 *
 * All aggregates are Promise.all'd in one round-trip with the snapshot + counts.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sseService: SseService,
    private readonly labels: AuditTargetLabelService,
  ) {}

  async summary() {
    const now = new Date();
    const [
      snap,
      totalUsers,
      activeSessions,
      fedGroups,
      mediaAgg,
      tasksAgg,
      uploadsCount,
      downloadAgg,
      recentActionRows,
    ] = await Promise.all([
      this.sseService.snapshot(),
      this.database.db
        .select({ value: count() })
        .from(account)
        .where(and(eq(account.namespaceId, 0), eq(account.kind, 'USER')))
        .then(([row]) => row.value),
      this.database.db
        .select({ value: count() })
        .from(sessionToken)
        .where(
          and(
            isNull(sessionToken.revokedAt),
            or(isNull(sessionToken.expiresAt), gt(sessionToken.expiresAt, now)),
          ),
        )
        .then(([row]) => row.value),
      this.database.db
        .select({ trustLevel: identityNamespace.trustLevel, value: count() })
        .from(identityNamespace)
        .where(gt(identityNamespace.id, 0))
        .groupBy(identityNamespace.trustLevel),
      this.database.db
        .select({
          bytes: sql<bigint>`coalesce(sum(${mediaAsset.bytes}), 0)::bigint`,
          assetCount: count(),
          live: sql<number>`count(*) filter (where ${mediaAsset.isDeleted} = false)::int`,
          deleted: sql<number>`count(*) filter (where ${mediaAsset.isDeleted} = true)::int`,
        })
        .from(mediaAsset)
        .then(([row]) => row),
      this.database.db
        .select({
          processing: sql<number>`count(*) filter (where ${durableTask.status} = 'PROCESSING')::int`,
          pending: sql<number>`count(*) filter (where ${durableTask.status} = 'PENDING')::int`,
          failed: sql<number>`count(*) filter (where ${durableTask.status} = 'FAILED')::int`,
        })
        .from(durableTask)
        .then(([row]) => row),
      this.database.db
        .select({ value: count() })
        .from(uploadSession)
        .where(inArray(uploadSession.status, ['UPLOADING', 'COMPLETING']))
        .then(([row]) => row.value),
      this.database.db
        .select({
          active: sql<number>`count(*) filter (where ${pendingMedia.status} in ('PENDING', 'PROCESSING'))::int`,
          failed: sql<number>`count(*) filter (where ${pendingMedia.status} = 'FAILED' or ${pendingMedia.anyFailed} = true)::int`,
        })
        .from(pendingMedia)
        .where(eq(pendingMedia.direction, 'INBOUND'))
        .then(([row]) => row),
      this.database.db
        .select({
          id: adminActionLog.id,
          action: adminActionLog.action,
          targetType: adminActionLog.targetType,
          targetId: adminActionLog.targetId,
          adminId: adminActionLog.adminId,
          adminRole: adminActionLog.adminRole,
          status: adminActionLog.status,
          errorMessage: adminActionLog.errorMessage,
          ip: adminActionLog.ip,
          createdAt: adminActionLog.createdAt,
        })
        .from(adminActionLog)
        .orderBy(desc(adminActionLog.createdAt))
        .limit(10),
    ]);

    const federation = {
      unrecognized: 0,
      establishing: 0,
      available: 0,
      degraded: 0,
      halted: 0,
    };
    for (const g of fedGroups) {
      const lvl = g.trustLevel as keyof typeof federation;
      if (lvl in federation) federation[lvl] = g.value;
    }

    // Resolve targetIds into account names — same shared resolver as the audit log, so the dashboard's
    // recent-actions strip reads "user: alice" rather than "user: 7".
    const labelByKey = await this.labels.resolve(recentActionRows);
    const recentActions = recentActionRows.map((r) => ({
      ...r,
      targetLabel:
        r.targetType && r.targetId
          ? (labelByKey.get(`${r.targetType}:${r.targetId}`) ?? null)
          : null,
    }));

    return {
      online: { totalConnections: snap.total, uniqueUsers: snap.uniqueUsers },
      totalUsers,
      activeSessions,
      federation,
      media: {
        bytes: BigInt(mediaAgg.bytes),
        assetCount: mediaAgg.assetCount,
        live: mediaAgg.live,
        deleted: mediaAgg.deleted,
      },
      tasks: {
        processing: tasksAgg.processing,
        pending: tasksAgg.pending,
        failed: tasksAgg.failed,
      },
      transfers: {
        activeUploads: uploadsCount,
        activeDownloads: downloadAgg.active,
        failedTransfers: downloadAgg.failed,
      },
      recentActions,
    };
  }
}
