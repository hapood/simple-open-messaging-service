import { HttpStatus } from '@nestjs/common';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { toClientIdentity } from '../common/client-identity.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  groupMetaMemberFeed,
  groupMetaProfileFeed,
} from '../database/schema.js';

interface GroupMetaFeedItemBase {
  feedId: string;
  account: string;
  domain: string;
  namespaceId?: number;
}

export type GroupMetaFeedItem =
  | (GroupMetaFeedItemBase & {
      operation: 'UPSERT';
      body: Record<string, unknown>;
    })
  | (GroupMetaFeedItemBase & { operation: 'DEPART' })
  | {
      feedId: string;
      operation: 'GROUP_PROFILE';
      body: { profileRev: number };
    };

export interface GroupMetaFeedPage {
  account: string;
  mode: 'full' | 'delta';
  items: GroupMetaFeedItem[];
  scannedThrough: string;
  groupMetaFeedEndId: string;
  hasMore: boolean;
}

export interface GroupMetaPageRead {
  groupId: number;
  account: string;
  mode: 'full' | 'delta';
  after: bigint | undefined;
  take: number;
  through?: bigint;
  end: bigint;
  visibleAfter: bigint;
  client?: { localDomain: string };
}

const MAX_TAKE = 200;

/** Read one page from the shared group-scoped Group Meta coordinate space. */
export async function readGroupMetaPageInTx(
  tx: DatabaseTransaction,
  params: GroupMetaPageRead,
): Promise<GroupMetaFeedPage> {
  const cursorData = {
    resumeAfter: '0',
    resumeBefore: (params.end + 1n).toString(),
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
    params.after < 0n ||
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
            memberNamespaceId: groupMetaMemberFeed.memberNamespaceId,
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
            feedId: string;
            memberAccount: string;
            memberDomain: string;
            memberNamespaceId: number;
            operation: 'UPSERT';
            body: Record<string, unknown>;
          }>(sql`
            SELECT latest.* FROM (
              SELECT DISTINCT ON (member_fact."memberNamespaceId", member_fact."memberDomain", member_fact."memberAccount")
                member_fact."feedId",
                member_fact."memberAccount" AS "memberAccount",
                member_fact."memberDomain" AS "memberDomain",
                member_fact."memberNamespaceId" AS "memberNamespaceId",
                member_fact.operation,
                member_fact.body
              FROM "GroupMetaMemberFeed" member_fact
              WHERE member_fact."threadId" = ${params.groupId}
                AND member_fact."feedId" <= ${scanEnd}
              ORDER BY member_fact."memberNamespaceId", member_fact."memberDomain", member_fact."memberAccount", member_fact."feedId" DESC
            ) latest
            WHERE latest.operation = 'UPSERT' AND latest."feedId" > ${params.after}
            ORDER BY latest."feedId"
            LIMIT ${queryLimit}
          `)
        ).rows;
  const [profileRow] = await tx
    .select({
      feedId: groupMetaProfileFeed.feedId,
      profileRev: groupMetaProfileFeed.profileRev,
    })
    .from(groupMetaProfileFeed)
    .where(
      and(
        eq(groupMetaProfileFeed.threadId, params.groupId),
        sql`${groupMetaProfileFeed.feedId} > ${params.after}`,
        lte(groupMetaProfileFeed.feedId, scanEnd),
      ),
    )
    .limit(1);
  const items: GroupMetaFeedItem[] = [
    ...memberRows.map((row): GroupMetaFeedItem => {
      const identity = {
        account: row.memberAccount,
        domain: row.memberDomain,
        namespaceId: row.memberNamespaceId,
      };
      const base = {
        feedId: row.feedId.toString(),
        ...(params.client
          ? toClientIdentity(identity, params.client.localDomain)
          : { account: identity.account, domain: identity.domain }),
      };
      return row.operation === 'UPSERT'
        ? { ...base, operation: 'UPSERT', body: row.body }
        : { ...base, operation: 'DEPART' };
    }),
    ...(profileRow
      ? [
          {
            feedId: profileRow.feedId.toString(),
            operation: 'GROUP_PROFILE' as const,
            body: { profileRev: profileRow.profileRev },
          },
        ]
      : []),
  ].sort((left, right) =>
    BigInt(left.feedId) < BigInt(right.feedId) ? -1 : 1,
  );
  const hasMore = items.length > params.take;
  const pageItems = hasMore ? items.slice(0, params.take) : items;
  const scannedThrough = hasMore ? BigInt(pageItems.at(-1)!.feedId) : scanEnd;
  return {
    account: params.account,
    mode: params.mode,
    items: pageItems,
    scannedThrough: scannedThrough.toString(),
    groupMetaFeedEndId: params.end.toString(),
    hasMore,
  };
}
