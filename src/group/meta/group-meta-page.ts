import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { HttpStatus } from '@nestjs/common';
import { BusinessCode } from '../../common/business-code.js';
import { BusinessException } from '../../common/business.exception.js';
import { toClientIdentity } from '../../common/client-identity.js';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { groupMetaMemberFeed } from '../../database/schema.js';

interface GroupMetaFeedItemBase {
  feedId: number;
  account: string;
  domain: string;
  namespaceId?: number;
}

type GroupMetaFeedItem =
  | (GroupMetaFeedItemBase & {
      operation: 'UPSERT';
      body: Record<string, unknown>;
    })
  | (GroupMetaFeedItemBase & { operation: 'DEPART' })
  | {
      feedId: number;
      operation: 'GROUP_PROFILE';
      body: { profileRev: number };
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
  mode: 'full' | 'delta';
  after: number | undefined;
  take: number;
  through?: number;
  end: number;
  visibleAfter: number;
  client?: { localDomain: string };
}

const MAX_TAKE = 200;

/** Read one page from the shared group-scoped Group Meta coordinate space.
 * Every coordinate — member facts and the GROUP_PROFILE fact alike — is a
 * stored row, so pages carry strictly increasing feed ids. */
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
      params.client
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
      params.client
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
    params.mode === 'delta'
      ? params.after < params.visibleAfter
      : scanEnd < params.visibleAfter;
  if (outsideCoordinateSpace || outsideVisibility)
    throw new BusinessException(
      params.client
        ? BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE
        : BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      'group meta cursor is outside the available coordinate space',
      HttpStatus.OK,
      cursorData,
    );
  const queryLimit = params.take + 1;
  const memberRows =
    params.mode === 'delta'
      ? await tx
          .select({
            feedId: groupMetaMemberFeed.feedId,
            memberAccount: groupMetaMemberFeed.memberAccount,
            memberDomain: groupMetaMemberFeed.memberDomain,
            operation: groupMetaMemberFeed.operation,
            body: groupMetaMemberFeed.body,
          })
          .from(groupMetaMemberFeed)
          .where(
            and(
              eq(groupMetaMemberFeed.threadId, params.groupId),
              sql`${groupMetaMemberFeed.feedId} > ${params.after}`,
              lte(groupMetaMemberFeed.feedId, scanEnd),
            ),
          )
          .orderBy(asc(groupMetaMemberFeed.feedId))
          .limit(queryLimit)
      : (
          await tx.execute<{
            feedId: number;
            memberAccount: string;
            memberDomain: string;
            operation: 'UPSERT' | 'GROUP_PROFILE';
            body: Record<string, unknown>;
          }>(sql`
            SELECT fact."feedId",
              fact."memberAccount" AS "memberAccount",
              fact."memberDomain" AS "memberDomain",
              fact.operation, fact.body
            FROM "GroupMetaMemberFeed" fact
            WHERE fact."threadId" = ${params.groupId}
              AND fact."feedId" <= ${scanEnd}
              AND fact."feedId" > ${params.after}
              AND fact.operation IN ('UPSERT', 'GROUP_PROFILE')
            ORDER BY fact."feedId"
            LIMIT ${queryLimit}
          `)
        ).rows;
  const namespaceByAddress = new Map<string, number>();
  if (
    params.client &&
    memberRows.some((row) => row.operation !== 'GROUP_PROFILE')
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
      if (row.operation === 'GROUP_PROFILE')
        return {
          feedId: row.feedId,
          operation: 'GROUP_PROFILE',
          body: { profileRev: Number(row.body.profileRev) },
        };
      const namespaceId = namespaceByAddress.get(
        JSON.stringify([row.memberDomain, row.memberAccount]),
      );
      if (params.client && namespaceId === undefined)
        throw new Error('group-meta client identity namespace is missing');
      const identity = {
        account: row.memberAccount,
        domain: row.memberDomain,
        namespaceId: namespaceId ?? 0,
      };
      const base = {
        feedId: row.feedId,
        ...(params.client
          ? toClientIdentity(identity, params.client.localDomain)
          : { account: identity.account, domain: identity.domain }),
      };
      return row.operation === 'UPSERT'
        ? { ...base, operation: 'UPSERT', body: row.body }
        : { ...base, operation: 'DEPART' };
    })
    .sort((left, right) => left.feedId - right.feedId);
  const hasMore = items.length > params.take;
  const pageItems = hasMore ? items.slice(0, params.take) : items;
  const scannedThrough = hasMore
    ? pageItems[pageItems.length - 1]!.feedId
    : scanEnd;
  return {
    account: params.account,
    mode: params.mode,
    items: pageItems,
    scannedThrough,
    groupMetaFeedEndId: params.end,
    hasMore,
  };
}
