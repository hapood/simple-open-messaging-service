import { Injectable } from '@nestjs/common';
import { and, count, desc, gt, isNull, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  adminActionLog,
  federatedPeer,
  mediaAsset,
  sessionToken,
} from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';
import { AuditTargetLabelService } from './audit-target-label.service.js';

/**
 * Console overview aggregator. Every metric is a cheap read so the dashboard can poll:
 *  - online: the in-memory SSE connection snapshot (live downlinks, aggregated per user).
 *  - activeSessions: active user session tokens (unrevoked, not past their sliding deadline).
 *  - federation: peer counts grouped by trustLevel.
 *  - media: total content bytes + asset count from MediaAsset.
 *    Uses the table aggregate, not a filesystem walk — reflects managed media and is O(1)-ish.
 *  - recentActions: the last 10 AdminActionLog rows (written by AdminAuditInterceptor).
 *
 * The federation/media aggregates are Promise.all'd in one round-trip with the snapshot + counts.
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
    const [snap, activeSessions, fedGroups, mediaAgg, recentActionRows] =
      await Promise.all([
        this.sseService.snapshot(),
        this.database.db
          .select({ value: count() })
          .from(sessionToken)
          .where(
            and(
              isNull(sessionToken.revokedAt),
              or(
                isNull(sessionToken.expiresAt),
                gt(sessionToken.expiresAt, now),
              ),
            ),
          )
          .then(([row]) => row.value),
        this.database.db
          .select({ trustLevel: federatedPeer.trustLevel, value: count() })
          .from(federatedPeer)
          .groupBy(federatedPeer.trustLevel),
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
            id: adminActionLog.id,
            action: adminActionLog.action,
            targetType: adminActionLog.targetType,
            targetId: adminActionLog.targetId,
            adminId: adminActionLog.adminId,
            adminRole: adminActionLog.adminRole,
            status: adminActionLog.status,
            errorMessage: adminActionLog.errorMessage,
            ip: adminActionLog.ip,
            at: adminActionLog.at,
          })
          .from(adminActionLog)
          .orderBy(desc(adminActionLog.at))
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
      activeSessions,
      federation,
      media: {
        bytes: BigInt(mediaAgg.bytes),
        assetCount: mediaAgg.assetCount,
        live: mediaAgg.live,
        deleted: mediaAgg.deleted,
      },
      recentActions,
    };
  }
}
