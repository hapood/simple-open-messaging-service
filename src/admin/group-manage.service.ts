import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { group, messageThread } from '../database/schema.js';
import type { AdminGroupsListDto } from './admin.dto.js';

/**
 * Read-only group/thread observability. Lists GROUP threads with their independent group profile,
 * active member count, and federation origin (originDomain / fedGroupAccount) — especially useful
 * now that Step 3 lands cross-server groups. Extracted from the controller so the controller is a
 * pure HTTP adapter and the query is unit-testable (mirrors DashboardService). Destructive group ops
 * (dissolve/transfer) are a follow-up.
 *
 * Returns the raw { list, total } payload; the global SerializeInterceptor wraps the ApiResult envelope.
 */
@Injectable()
export class GroupManageService {
  constructor(private readonly database: DatabaseService) {}

  async list(dto: AdminGroupsListDto) {
    const search = dto.search
      ? or(
          ilike(group.account, `%${dto.search}%`),
          ilike(group.name, `%${dto.search}%`),
        )
      : undefined;
    const where = and(eq(messageThread.type, 'GROUP'), search);
    const memberCount = sql<number>`(
      SELECT count(*)::int
      FROM (
        SELECT DISTINCT ON (member_identity.domain, member_identity.account)
          member_fact.operation
        FROM "GroupMetaMemberFeed" member_fact
        JOIN "User" member_identity
          ON member_identity.id = member_fact."memberUserId"
        WHERE member_fact."groupId" = ${group.id}
        ORDER BY member_identity.domain, member_identity.account,
          member_fact."feedId" DESC
      ) latest
      WHERE latest.operation = 'UPSERT'
    )`;
    const base = this.database.db
      .select({
        id: messageThread.id,
        createdAt: messageThread.createdAt,
        lastMessageAt: messageThread.lastMessageAt,
        lastMessagePreview: messageThread.lastMessagePreview,
        groupAccount: group.account,
        groupName: group.name,
        groupDomain: group.domain,
        memberCount,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(where);
    const [rows, totalRow] = await Promise.all([
      base
        .orderBy(desc(messageThread.createdAt))
        .offset(dto.skip ?? 0)
        .limit(dto.take ?? 50),
      this.database.db
        .select({ value: count() })
        .from(messageThread)
        .innerJoin(group, eq(group.id, messageThread.groupId))
        .where(where)
        .then(([row]) => row),
    ]);
    const list = rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      lastMessageAt: row.lastMessageAt,
      lastMessagePreview: row.lastMessagePreview,
      group: {
        account: row.groupAccount,
        name: row.groupName,
        domain: row.groupDomain,
      },
      memberCount: row.memberCount,
    }));
    const total = totalRow.value;
    return { list, total };
  }
}
