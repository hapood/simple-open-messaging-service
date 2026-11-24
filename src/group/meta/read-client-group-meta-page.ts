import { sql } from 'drizzle-orm';
import { HttpStatus } from '@nestjs/common';
import type { ClientGroupMetaFact } from '../../../shared/client-group-meta.js';
import { BusinessCode } from '../../common/business-code.js';
import { BusinessException } from '../../common/business.exception.js';
import type { DatabaseTransaction } from '../../database/database.service.js';

export interface ClientGroupMetaPage {
  account: string;
  items: ClientGroupMetaFact[];
  scannedThrough: number;
  groupMetaFeedEndId: number;
  hasMore: boolean;
}

const MAX_TAKE = 200;

/** Page the client-only projection. Member roster and profile facts are never selected here. */
export async function readClientGroupMetaPageInTx(
  tx: DatabaseTransaction,
  params: {
    groupId: number;
    account: string;
    after: number;
    take: number;
    through?: number;
    end: number;
  },
): Promise<ClientGroupMetaPage> {
  if (
    !Number.isSafeInteger(params.after) ||
    params.after < 0 ||
    (params.through !== undefined && params.through < params.after) ||
    !Number.isSafeInteger(params.take) ||
    params.take < 1 ||
    params.take > MAX_TAKE
  )
    throw new BusinessException(
      BusinessCode.VALIDATION_FAILED,
      'invalid group-meta cursor or page size',
      HttpStatus.BAD_REQUEST,
    );
  const scanEnd =
    params.through === undefined || params.through > params.end
      ? params.end
      : params.through;
  if (params.after > params.end)
    throw new BusinessException(
      BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
      'group meta cursor is outside the available coordinate space',
      HttpStatus.OK,
      { resumeAfter: '0', resumeBefore: String(params.end + 1) },
    );
  const rows = await tx.execute<{
    feedId: number;
    operation: ClientGroupMetaFact['operation'];
    body: ClientGroupMetaFact['body'];
    createdAt: Date | string;
    originCreatedAt: Date | string | null;
  }>(sql`
    SELECT "feedId", operation, body, "createdAt", "originCreatedAt"
    FROM "ClientGroupMetaFeed"
    WHERE "threadId" = ${params.groupId}
      AND "feedId" > ${params.after} AND "feedId" <= ${scanEnd}
      AND operation IN ('GROUP_MEMBER_COUNT', 'GROUP_ANNOUNCEMENT')
    ORDER BY "feedId"
    LIMIT ${params.take + 1}
  `);
  const hasMore = rows.rows.length > params.take;
  const items = (hasMore ? rows.rows.slice(0, params.take) : rows.rows).map(
    (row): ClientGroupMetaFact => {
      const createdAt = new Date(row.createdAt).getTime();
      const originCreatedAt =
        row.originCreatedAt === null
          ? null
          : new Date(row.originCreatedAt).getTime();
      if (row.operation === 'GROUP_MEMBER_COUNT') {
        return {
          feedId: row.feedId,
          createdAt,
          originCreatedAt,
          operation: 'GROUP_MEMBER_COUNT',
          body: row.body as { memberCount: number },
        };
      }
      return {
        feedId: row.feedId,
        createdAt,
        originCreatedAt,
        operation: 'GROUP_ANNOUNCEMENT',
        body: row.body as { text: string | null },
      };
    },
  );
  return {
    account: params.account,
    items,
    scannedThrough: hasMore ? items.at(-1)!.feedId : scanEnd,
    groupMetaFeedEndId: params.end,
    hasMore,
  };
}
