import { groupStateSql } from '../group/shared/group-state.js';

import { HttpStatus, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { groupMeta } from '../database/schema.js';
import { readClientGroupMetaPageInTx } from '../group/meta/read-client-group-meta-page.js';
import type { GroupMetaFeedDemand } from '../../shared/group-meta-demand.js';

export type { GroupMetaFeedDemand } from '../../shared/group-meta-demand.js';

@Injectable()
export class ClientGroupMetaFeedService {
  constructor(private readonly database: DatabaseService) {}

  async resolveVisibleGroup(
    userId: number,
    demand: GroupMetaFeedDemand,
  ): Promise<{ groupId: number; account: string }> {
    const coordinate =
      'threadId' in demand
        ? sql`AND thread.id = ${demand.threadId}`
        : sql`AND group_state.account = ${demand.account}
          AND group_state."namespaceId" = ${demand.namespaceId}`;
    const rows = await this.database.db.execute<{
      groupId: number;
      account: string;
    }>(sql`
      SELECT group_state.id AS "groupId", group_state.account
      FROM "MessageThread" thread
      JOIN ${groupStateSql} group_state ON group_state.id = thread.id
      JOIN "AccountThreadState" participant
        ON participant."threadId" = thread.id
       AND participant."accountId" = ${userId}
      JOIN "Account" local_user ON local_user.id = ${userId}
      WHERE thread.type = 'GROUP'
        AND (
          participant."groupMetaVisibleThroughId" IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM "RelationshipPair" pair
            WHERE pair."threadId" = thread.id AND pair.active = true
              AND pair.kind = 'GROUP_MEMBER'
              AND (
                (pair."endpointAType" = 'USER'
                  AND pair."endpointAAccount" = local_user.account
                  AND pair."endpointANamespaceId" = 0)
                OR
                (pair."endpointBType" = 'USER'
                  AND pair."endpointBAccount" = local_user.account
                  AND pair."endpointBNamespaceId" = 0)
              )
          )
        )
        ${coordinate}
      LIMIT 1
    `);
    const resolved = rows.rows[0];
    if (!resolved) return this.forbidden();
    return resolved;
  }

  async serve(
    userId: number,
    groupId: number,
    account: string,
    after: number,
    take: number,
    through?: number,
  ) {
    return this.database.db.transaction(
      async (tx) => {
        const authorized = await tx.execute<{
          groupId: number;
          visibleThroughId: number | null;
        }>(sql`
        SELECT group_state.id AS "groupId",
          participant."groupMetaVisibleThroughId" AS "visibleThroughId"
        FROM "MessageThread" thread
        JOIN ${groupStateSql} group_state ON group_state.id = thread.id
        JOIN "AccountThreadState" participant
          ON participant."threadId" = thread.id
         AND participant."accountId" = ${userId}
        JOIN "Account" local_user ON local_user.id = ${userId}
        WHERE thread.type = 'GROUP'
          AND group_state.id = ${groupId}
          AND group_state.account = ${account}
          AND (
            participant."groupMetaVisibleThroughId" IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM "RelationshipPair" pair
              WHERE pair."threadId" = thread.id AND pair.active = true
                AND pair.kind = 'GROUP_MEMBER'
                AND (
                  (pair."endpointAType" = 'USER'
                    AND pair."endpointAAccount" = local_user.account
                    AND pair."endpointANamespaceId" = 0)
                  OR
                  (pair."endpointBType" = 'USER'
                    AND pair."endpointBAccount" = local_user.account
                    AND pair."endpointBNamespaceId" = 0)
                )
            )
          )
        LIMIT 1
      `);
        const access = authorized.rows[0];
        if (!access) return this.forbidden();
        const [feed] = await tx
          .select({ clientMetaEndId: groupMeta.clientMetaEndId })
          .from(groupMeta)
          .where(eq(groupMeta.threadId, groupId))
          .limit(1);
        if (!feed)
          throw new BusinessException(
            BusinessCode.GROUP_MEMBERS_NOT_READY,
            'group meta is not ready',
            HttpStatus.OK,
          );
        const end =
          access.visibleThroughId === null
            ? feed.clientMetaEndId
            : Math.min(feed.clientMetaEndId, access.visibleThroughId);
        const page = await readClientGroupMetaPageInTx(tx, {
          groupId,
          account,
          after,
          take,
          through,
          end,
        });
        return {
          ...page,
          scannedThrough: String(page.scannedThrough),
          groupMetaFeedEndId: String(page.groupMetaFeedEndId),
          items: page.items.map((item) => ({
            ...item,
            feedId: String(item.feedId),
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private forbidden(): never {
    throw new BusinessException(
      BusinessCode.FORBIDDEN,
      'group meta is not visible to this user',
      HttpStatus.FORBIDDEN,
    );
  }
}
