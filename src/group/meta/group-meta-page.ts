import { sql } from 'drizzle-orm';
import { HttpStatus } from '@nestjs/common';
import { BusinessCode } from '../../common/business-code.js';
import { BusinessException } from '../../common/business.exception.js';
import { toClientIdentity } from '../../common/client-identity.js';
import type { DatabaseTransaction } from '../../database/database.service.js';

interface GroupMetaFeedItemBase {
  feedId: number;
  account: string;
  domain: string;
  namespaceId?: number;
}

type GroupMetaFeedItem =
  | (GroupMetaFeedItemBase & {
      operation: 'MEMBER_UPSERT';
      body: Record<string, unknown>;
    })
  | (GroupMetaFeedItemBase & {
      operation: 'MEMBER_DEPART';
      body: Record<string, unknown>;
    })
  | {
      feedId: number;
      operation: 'GROUP_PROFILE';
      body: { profileNamespaceId: number; profileRev: number };
    }
  | {
      feedId: number;
      operation: 'GROUP_ANNOUNCEMENT';
      body: { text: string | null };
    };

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
      memberAccount: string | null;
      memberDomain: string | null;
      operation: 'MEMBER_UPSERT' | 'MEMBER_DEPART' | 'GROUP_PROFILE' | 'GROUP_ANNOUNCEMENT';
      body: Record<string, unknown>;
    }>(sql`
    SELECT fact."feedId", fact."memberAccount" AS "memberAccount",
      fact."memberDomain" AS "memberDomain", fact.operation::text AS operation,
      fact.body
    FROM "GroupMetaMemberFeed" fact
    WHERE fact."threadId" = ${params.groupId}
      AND fact."feedId" > ${params.after} AND fact."feedId" <= ${scanEnd}
      ${params.feedMode === 'full' ? sql`AND fact.operation IN ('MEMBER_UPSERT', 'GROUP_PROFILE')` : sql.empty()}
    UNION ALL
    SELECT meta."announcementFeedId", NULL::varchar, NULL::varchar,
      'GROUP_ANNOUNCEMENT'::text, jsonb_build_object('text', meta."announcementText")
    FROM "GroupMeta" meta WHERE meta."threadId" = ${params.groupId}
      AND meta."announcementFeedId" > ${params.after}
      AND meta."announcementFeedId" <= ${scanEnd}
    ORDER BY "feedId" LIMIT ${queryLimit}
  `)
  ).rows;
  const namespaceByAddress = new Map<string, number>();
  if (
    params.viewMode === 'client' &&
    memberRows.some(
      (row) => row.operation === 'MEMBER_UPSERT' || row.operation === 'MEMBER_DEPART',
    )
  ) {
    const identities = await tx.execute<{
      memberAccount: string;
      memberDomain: string;
      namespaceId: number;
    }>(sql`
      SELECT fact."memberAccount", fact."memberDomain",
        group_meta_member_namespace(fact."threadId", fact."memberAccount",
          fact."memberDomain") AS "namespaceId"
      FROM "GroupMetaMemberFeed" fact
      WHERE fact."threadId" = ${params.groupId}
    `);
    for (const identity of identities.rows)
      namespaceByAddress.set(
        JSON.stringify([identity.memberDomain, identity.memberAccount]),
        identity.namespaceId,
      );
  }
  const items: GroupMetaFeedItem[] = memberRows
    .map((row): GroupMetaFeedItem => {
      if (row.operation === 'GROUP_ANNOUNCEMENT')
        return {
          feedId: row.feedId,
          operation: 'GROUP_ANNOUNCEMENT',
          body: { text: row.body.text as string | null },
        };
      if (row.operation === 'GROUP_PROFILE')
        return {
          feedId: row.feedId,
          operation: 'GROUP_PROFILE',
          body: {
            profileNamespaceId: Number(row.body.profileNamespaceId),
            profileRev: Number(row.body.profileRev),
          },
        };
      const namespaceId = namespaceByAddress.get(
        JSON.stringify([row.memberDomain, row.memberAccount]),
      );
      if (row.memberDomain === null || row.memberAccount === null)
        throw new Error('group-meta member identity is missing');
      if (params.viewMode === 'client' && namespaceId === undefined)
        throw new Error('group-meta client identity namespace is missing');
      const identity = {
        account: row.memberAccount,
        domain: row.memberDomain,
        namespaceId: namespaceId ?? 0,
      };
      const base = {
        feedId: row.feedId,
        ...(params.viewMode === 'client'
          ? toClientIdentity(identity)
          : { account: identity.account, domain: identity.domain }),
      };
      return {
        ...base,
        operation: row.operation,
        body: row.body,
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
