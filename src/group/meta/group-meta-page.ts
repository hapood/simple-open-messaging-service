import { sql } from 'drizzle-orm';
import { HttpStatus } from '@nestjs/common';
import { BusinessCode } from '../../common/business-code.js';
import { BusinessException } from '../../common/business.exception.js';
import type { DatabaseTransaction } from '../../database/database.service.js';

interface GroupMetaCopyTimes {
  /** First persistence at this publisher, in epoch milliseconds. */
  createdAt: number;
  /** Direct source copy time; null on the group's origin. */
  originCreatedAt: number | null;
}

/** Shared operation bodies and coordinates, independent of local or federation
 * timestamp projection. Subject identities use the publisher's namespace. */
export type GroupMetaFact =
  | {
      feedId: number;
      operation: 'MEMBER_UPSERT';
      body: {
        account: string;
        namespaceId: number;
        role: 'OWNER' | 'ADMIN' | 'MEMBER';
        profileRev: number;
      };
    }
  | {
      feedId: number;
      operation: 'MEMBER_DEPART';
      body: {
        account: string;
        namespaceId: number;
        role: 'OWNER' | 'ADMIN' | 'MEMBER';
        profileRev: number;
      };
    }
  | {
      feedId: number;
      operation: 'GROUP_PROFILE';
      body: { account: string; namespaceId: number; profileRev: number };
    }
  | {
      feedId: number;
      operation: 'GROUP_ANNOUNCEMENT';
      body: { text: string | null };
    };

export type GroupMetaFeedItem = GroupMetaFact & GroupMetaCopyTimes;

export interface GroupMetaFeedPage {
  account: string;
  mode: 'full' | 'delta';
  items: GroupMetaFeedItem[];
  scannedThrough: number;
  groupMetaFeedEndId: number;
  hasMore: boolean;
}

export interface GroupMetaPageRead {
  groupId: number;
  account: string;
  viewMode: 'federation' | 'client';
  feedMode: 'full' | 'delta';
  after: number | undefined;
  take: number;
  through?: number;
  end: number;
  visibleAfter: number;
}

const MAX_TAKE = 200;

/** Read one page from the shared group-scoped Group Meta coordinate space.
 * Member and profile facts share a coordinate space with the current
 * group-wide announcement projection. */
export async function readGroupMetaPageInTx(
  tx: DatabaseTransaction,
  params: GroupMetaPageRead,
): Promise<GroupMetaFeedPage> {
  const cursorData = {
    resumeAfter: 0,
    resumeBefore: params.end + 1,
  };
  if (params.after === undefined)
    throw new BusinessException(
      params.viewMode === 'client'
        ? BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE
        : BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'after is required; initialize the group-meta feed cursor',
      HttpStatus.OK,
      cursorData,
    );
  if (
    !Number.isSafeInteger(params.after) ||
    params.after < 0 ||
    (params.through !== undefined && params.through < params.after) ||
    !Number.isSafeInteger(params.take) ||
    params.take < 1 ||
    params.take > MAX_TAKE
  )
    throw new BusinessException(
      params.viewMode === 'client'
        ? BusinessCode.VALIDATION_FAILED
        : BusinessCode.FEDERATION_MALFORMED,
      'invalid group-meta cursor or page size',
      HttpStatus.BAD_REQUEST,
    );
  const scanEnd =
    params.through === undefined || params.through > params.end
      ? params.end
      : params.through;
  const outsideCoordinateSpace = params.after > params.end;
  const outsideVisibility =
    params.feedMode === 'delta'
      ? params.after < params.visibleAfter
      : scanEnd < params.visibleAfter;
  if (outsideCoordinateSpace || outsideVisibility)
    throw new BusinessException(
      params.viewMode === 'client'
        ? BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE
        : BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'group meta cursor is outside the available coordinate space',
      HttpStatus.OK,
      cursorData,
    );
  const queryLimit = params.take + 1;
  const memberRows = (
    await tx.execute<{
      feedId: number;
      operation:
        | 'MEMBER_UPSERT'
        | 'MEMBER_DEPART'
        | 'GROUP_PROFILE'
        | 'GROUP_ANNOUNCEMENT';
      body: Record<string, unknown>;
      createdAt: Date | string;
      originCreatedAt: Date | string | null;
    }>(sql`
    SELECT fact."feedId", fact.operation::text AS operation, fact.body, fact."createdAt", fact."originCreatedAt"
    FROM "GroupMetaMemberFeed" fact
    WHERE fact."threadId" = ${params.groupId}
      AND fact."feedId" > ${params.after} AND fact."feedId" <= ${scanEnd}
      ${params.feedMode === 'full' ? sql`AND fact.operation <> 'MEMBER_DEPART'` : sql.empty()}
    ORDER BY "feedId" LIMIT ${queryLimit}
  `)
  ).rows;
  const items: GroupMetaFeedItem[] = memberRows
    .map((row): GroupMetaFeedItem => {
      const times = {
        createdAt: new Date(row.createdAt).getTime(),
        originCreatedAt:
          row.originCreatedAt === null
            ? null
            : new Date(row.originCreatedAt).getTime(),
      };
      if (row.operation === 'GROUP_ANNOUNCEMENT')
        return {
          feedId: row.feedId,
          ...times,
          operation: 'GROUP_ANNOUNCEMENT',
          body: { text: (row.body.text as string | null) ?? null },
        };
      if (row.operation === 'GROUP_PROFILE')
        return {
          feedId: row.feedId,
          ...times,
          operation: 'GROUP_PROFILE',
          body: {
            account: String(row.body.account),
            namespaceId: Number(row.body.namespaceId),
            profileRev: Number(row.body.profileRev),
          },
        };
      return {
        feedId: row.feedId,
        ...times,
        operation: row.operation,
        body: {
          account: String(row.body.account),
          namespaceId: Number(row.body.namespaceId),
          role: row.body.role as 'OWNER' | 'ADMIN' | 'MEMBER',
          profileRev: Number(row.body.profileRev),
        },
      };
    })
    .sort((left, right) => left.feedId - right.feedId);
  const hasMore = items.length > params.take;
  const pageItems = hasMore ? items.slice(0, params.take) : items;
  const scannedThrough = hasMore
    ? pageItems[pageItems.length - 1]!.feedId
    : scanEnd;
  return {
    account: params.account,
    mode: params.feedMode,
    items: pageItems,
    scannedThrough,
    groupMetaFeedEndId: params.end,
    hasMore,
  };
}
