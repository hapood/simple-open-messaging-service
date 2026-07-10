import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { SseService } from '../gateway/sse.service.js';

/**
 * Console overview aggregator. Every metric is a cheap read so the dashboard can poll:
 *  - online: the in-memory SSE connection snapshot (live downlinks, aggregated per user).
 *  - activeSessions: unexpired, unrevoked user refresh tokens.
 *  - federation: peer counts grouped by trustLevel.
 *  - media: total content bytes + asset count from MediaAsset (CAS, deduped) + reclaimable (refs<=0).
 *    Uses the table aggregate, not a filesystem walk — reflects managed media and is O(1)-ish.
 *  - recentActions: the last 10 AdminActionLog rows (written by AdminAuditInterceptor).
 *
 * The federation/media aggregates are Promise.all'd in one round-trip with the snapshot + counts.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sseService: SseService,
  ) {}

  async summary() {
    const now = new Date();
    const [
      snap,
      activeSessions,
      fedGroups,
      mediaAgg,
      reclaimable,
      recentActions,
    ] = await Promise.all([
      this.sseService.snapshot(),
      this.prisma.refreshToken.count({
        where: { revokedAt: null, expiresAt: { gt: now } },
      }),
      this.prisma.federatedPeer.groupBy({
        by: ['trustLevel'],
        _count: { _all: true },
      }),
      this.prisma.mediaAsset.aggregate({
        _sum: { bytes: true },
        _count: true,
      }),
      this.prisma.mediaAsset.count({ where: { refs: { lte: 0 } } }),
      this.prisma.adminActionLog.findMany({
        take: 10,
        orderBy: { at: 'desc' },
        select: {
          id: true,
          action: true,
          targetType: true,
          targetId: true,
          adminId: true,
          adminRole: true,
          success: true,
          errorMessage: true,
          ip: true,
          at: true,
        },
      }),
    ]);

    const federation = { trusted: 0, demoted: 0, pending: 0, blocked: 0 };
    for (const g of fedGroups) {
      const lvl = g.trustLevel as keyof typeof federation;
      if (lvl in federation) federation[lvl] = g._count._all;
    }

    return {
      online: { totalConnections: snap.total, uniqueUsers: snap.uniqueUsers },
      activeSessions,
      federation,
      media: {
        bytes: mediaAgg._sum.bytes ?? 0n,
        assetCount: mediaAgg._count,
        reclaimable,
      },
      recentActions,
    };
  }
}
