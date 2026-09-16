import { groupStateSql } from '../group/business/shared/group-state.js';

import { HttpStatus, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { groupMeta } from '../database/schema.js';
import { readGroupMetaPageInTx } from '../group/business/meta/group-meta-page.js';
import { loadFederationConfig } from '../federation/federation.config.js';

@Injectable()
export class ClientGroupMetaFeedService {
  constructor(private readonly database: DatabaseService) {}

  async resolveVisibleGroup(
    userId: number,
    selector: { threadId?: number; account?: string; domain?: string },
  ): Promise<{ groupId: number; account: string }> {
    const rows = await this.database.db.execute<{
      groupId: number;
      account: string;
    }>(sql`
      SELECT group_state.id AS "groupId", group_state.account
      FROM "MessageThread" thread
      JOIN ${groupStateSql} group_state ON group_state.id = thread.id
      JOIN "Account" local_user ON local_user.id = ${userId}
      WHERE thread.type = 'GROUP'
        AND EXISTS (
          SELECT 1 FROM "RelationshipPair" pair
          WHERE pair."threadId" = thread.id AND pair.active = true
            AND ((pair."endpointAType" = 'USER'
                  AND pair."endpointAAccount" = local_user.account
                  AND pair."endpointADomain" = 'local')
              OR (pair."endpointBType" = 'USER'
                  AND pair."endpointBAccount" = local_user.account
                  AND pair."endpointBDomain" = 'local'))
        )
        AND (${selector.threadId ?? null}::integer IS NULL OR thread.id = ${selector.threadId ?? null})
        AND (${selector.account ?? null}::text IS NULL OR group_state.account = ${selector.account ?? null})
        AND (${selector.domain ?? null}::text IS NULL OR group_state.domain = ${selector.domain ?? null})
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
    mode: 'full' | 'delta',
    after: number,
    take: number,
    through?: number,
  ) {
    return this.database.db.transaction(async (tx) => {
      const authorized = await tx.execute<{ groupId: number }>(sql`
        SELECT group_state.id AS "groupId"
        FROM "MessageThread" thread
        JOIN ${groupStateSql} group_state ON group_state.id = thread.id
        JOIN "Account" local_user ON local_user.id = ${userId}
        WHERE thread.type = 'GROUP'
          AND group_state.id = ${groupId}
          AND group_state.account = ${account}
          AND EXISTS (
            SELECT 1 FROM "RelationshipPair" pair
            WHERE pair."threadId" = thread.id AND pair.active = true
              AND ((pair."endpointAType" = 'USER'
                    AND pair."endpointAAccount" = local_user.account
                    AND pair."endpointADomain" = 'local')
                OR (pair."endpointBType" = 'USER'
                    AND pair."endpointBAccount" = local_user.account
                    AND pair."endpointBDomain" = 'local'))
          )
        LIMIT 1
      `);
      if (!authorized.rows[0]) return this.forbidden();
      const [feed] = await tx
        .select({ metaEndId: groupMeta.metaEndId })
        .from(groupMeta)
        .where(eq(groupMeta.threadId, groupId))
        .limit(1);
      return readGroupMetaPageInTx(tx, {
        groupId,
        account,
        mode,
        after,
        take,
        through,
        end: feed?.metaEndId ?? 0,
        visibleAfter: 0,
        client: { localDomain: loadFederationConfig().domain },
      });
    });
  }

  private forbidden(): never {
    throw new BusinessException(
      BusinessCode.FORBIDDEN,
      'group meta is not visible to this user',
      HttpStatus.FORBIDDEN,
    );
  }
}
