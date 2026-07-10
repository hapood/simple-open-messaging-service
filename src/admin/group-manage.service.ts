import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { BusinessCode } from '../common/business-code.js';
import type { ApiResult } from '../common/api-result.js';
import type { AdminGroupsListDto } from './admin.dto.js';

/**
 * Read-only group/thread observability. Lists GROUP threads with their carrying "!"-User identity,
 * active member count, and federation origin (originDomain / fedGroupAccount) — especially useful
 * now that Step 3 lands cross-server groups. Extracted from the controller so the controller is a
 * pure HTTP adapter and the query is unit-testable (mirrors DashboardService). Destructive group ops
 * (dissolve/transfer) are a follow-up.
 */
@Injectable()
export class GroupManageService {
  constructor(private readonly prisma: PrismaService) {}

  async list(dto: AdminGroupsListDto): Promise<ApiResult> {
    const where = {
      type: 'GROUP' as const,
      ...(dto.search
        ? {
            groupUser: {
              OR: [
                { account: { contains: dto.search, mode: 'insensitive' as const } },
                { name: { contains: dto.search, mode: 'insensitive' as const } },
              ],
            },
          }
        : {}),
    };
    const [list, total] = await Promise.all([
      this.prisma.messageThread.findMany({
        where,
        skip: dto.skip ?? 0,
        take: dto.take ?? 50,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          lastMessageAt: true,
          lastMessagePreview: true,
          originDomain: true,
          fedGroupAccount: true,
          groupUser: { select: { account: true, name: true } },
          _count: { select: { ThreadParticipant: { where: { leftAt: null } } } },
        },
      }),
      this.prisma.messageThread.count({ where }),
    ]);
    return { code: BusinessCode.OK, message: 'success', data: { list, total } };
  }
}
