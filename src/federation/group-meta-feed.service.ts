import { HttpStatus, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import {
  groupMetaFeedTarget,
  groupMetaMemberFeed,
  group,
} from '../database/schema.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';

export interface GroupMetaMemberWrite {
  account: string;
  domain: string;
  body: Record<string, unknown>;
}

interface GroupMetaFeedItemBase {
  feedId: string;
  account: string;
  domain: string;
}

export type GroupMetaFeedItem = GroupMetaFeedItemBase &
  (
    | { operation: 'UPSERT'; body: Record<string, unknown> }
    | { operation: 'DEPART'; body: Record<string, never> }
  );

export interface GroupMetaFeedPage {
  account: string;
  mode: 'full' | 'delta';
  items: GroupMetaFeedItem[];
  scannedThrough: string;
  groupMetaFeedEndId: string;
  hasMore: boolean;
}

const DEFAULT_TAKE = 100;
const MAX_TAKE = 200;

@Injectable()
export class GroupMetaFeedService {
  constructor(private readonly database: DatabaseService) {}

  async deactivateTargetInTx(
    tx: DatabaseTransaction,
    targetPeerDomain: string,
    groupId: number,
  ): Promise<void> {
    await tx
      .update(groupMetaFeedTarget)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(groupMetaFeedTarget.targetPeerDomain, targetPeerDomain),
          eq(groupMetaFeedTarget.groupId, groupId),
        ),
      );
  }

  async reconcileInTx(
    tx: DatabaseTransaction,
    targetPeerDomain: string,
    groupId: number,
    members: readonly GroupMetaMemberWrite[],
  ): Promise<bigint> {
    await tx
      .insert(groupMetaFeedTarget)
      .values({ targetPeerDomain, groupId, active: true })
      .onConflictDoUpdate({
        target: [
          groupMetaFeedTarget.targetPeerDomain,
          groupMetaFeedTarget.groupId,
        ],
        set: { active: true, updatedAt: new Date() },
      });
    const locked = await tx.execute<{ allocatedThrough: bigint }>(sql`
      SELECT "allocatedThrough"
      FROM "GroupMetaFeedTarget"
      WHERE "targetPeerDomain" = ${targetPeerDomain}
        AND "groupId" = ${groupId}
      FOR UPDATE
    `);
    let allocatedThrough = BigInt(locked.rows[0]?.allocatedThrough ?? 0);
    const history = await tx
      .select({
        account: groupMetaMemberFeed.memberAccount,
        domain: groupMetaMemberFeed.memberDomain,
        operation: groupMetaMemberFeed.operation,
        body: groupMetaMemberFeed.body,
      })
      .from(groupMetaMemberFeed)
      .where(
        and(
          eq(groupMetaMemberFeed.targetPeerDomain, targetPeerDomain),
          eq(groupMetaMemberFeed.groupId, groupId),
        ),
      )
      .orderBy(asc(groupMetaMemberFeed.feedId));
    const current = new Map(
      history.map((item) => [`${item.domain}\u0000${item.account}`, item]),
    );
    const desired = new Map(
      members.map((member) => [
        `${member.domain}\u0000${member.account}`,
        {
          ...member,
          body: serializeBody(member.body) as Record<string, unknown>,
        },
      ]),
    );
    const changes: Array<{
      account: string;
      domain: string;
      operation: 'UPSERT' | 'DEPART';
      body: Record<string, unknown>;
    }> = [];
    for (const [key, member] of desired) {
      const previous = current.get(key);
      if (
        previous?.operation === 'UPSERT' &&
        isDeepStrictEqual(previous.body, member.body)
      )
        continue;
      changes.push({
        account: member.account,
        domain: member.domain,
        operation: 'UPSERT',
        body: member.body,
      });
    }
    for (const previous of current.values()) {
      const key = `${previous.domain}\u0000${previous.account}`;
      if (previous.operation !== 'UPSERT' || desired.has(key)) continue;
      changes.push({
        account: previous.account,
        domain: previous.domain,
        operation: 'DEPART',
        body: {},
      });
    }
    changes.sort(
      (a, b) =>
        (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0) ||
        (a.account < b.account ? -1 : a.account > b.account ? 1 : 0),
    );
    if (changes.length) {
      await tx.insert(groupMetaMemberFeed).values(
        changes.map((change) => ({
          targetPeerDomain,
          groupId,
          feedId: ++allocatedThrough,
          memberAccount: change.account,
          memberDomain: change.domain,
          operation: change.operation,
          body: change.body,
          updatedAt: new Date(),
        })),
      );
      await tx
        .update(groupMetaFeedTarget)
        .set({ allocatedThrough, updatedAt: new Date() })
        .where(
          and(
            eq(groupMetaFeedTarget.targetPeerDomain, targetPeerDomain),
            eq(groupMetaFeedTarget.groupId, groupId),
          ),
        );
    }
    return allocatedThrough;
  }

  async serve(
    peerDomain: string,
    account: string,
    mode: 'full' | 'delta',
    after: bigint | undefined,
    take = DEFAULT_TAKE,
    through?: bigint,
  ): Promise<GroupMetaFeedPage> {
    const [source] = await this.database.db
      .select({
        groupId: group.id,
        allocatedThrough: groupMetaFeedTarget.allocatedThrough,
        oldestAvailableAfter: groupMetaFeedTarget.oldestAvailableAfter,
      })
      .from(group)
      .innerJoin(
        groupMetaFeedTarget,
        and(
          eq(groupMetaFeedTarget.groupId, group.id),
          eq(groupMetaFeedTarget.targetPeerDomain, peerDomain),
        ),
      )
      .where(
        and(
          eq(group.account, account),
          eq(group.domain, 'local'),
          eq(groupMetaFeedTarget.active, true),
        ),
      )
      .limit(1);
    if (!source)
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'group meta is not visible to this peer',
        HttpStatus.FORBIDDEN,
      );
    const end = source.allocatedThrough;
    const cursorData = {
      resumeAfter: '0',
      resumeBefore: (end + 1n).toString(),
    };
    if (after === undefined)
      throw new BusinessException(
        BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
        'after is required; initialize the group-meta feed cursor',
        HttpStatus.OK,
        cursorData,
      );
    if (
      after < 0n ||
      (through !== undefined && through < after) ||
      !Number.isSafeInteger(take) ||
      take < 1 ||
      take > MAX_TAKE
    )
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'invalid group-meta cursor or page size',
        HttpStatus.BAD_REQUEST,
      );
    if (
      after > end ||
      (mode === 'delta' && after < source.oldestAvailableAfter)
    )
      throw new BusinessException(
        BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
        'group meta cursor is outside the available coordinate space',
        HttpStatus.OK,
        cursorData,
      );
    const scanEnd = through === undefined || through > end ? end : through;
    const limit = take + 1;
    // Full mode is an authoritative roster snapshot at scanEnd: select only the last operation for
    // each stable member key and emit it only when that operation is UPSERT. Delta mode preserves the
    // ordered mutation log, including DEPART. A bounded full drain therefore remains stable even when
    // newer roster changes are allocated concurrently above scanEnd.
    const modeFilter =
      mode === 'full'
        ? and(
            eq(groupMetaMemberFeed.operation, 'UPSERT'),
            sql`${groupMetaMemberFeed.feedId} = (
              SELECT MAX(latest."feedId")
              FROM "GroupMetaMemberFeed" latest
              WHERE latest."targetPeerDomain" = ${peerDomain}
                AND latest."groupId" = ${source.groupId}
                AND latest."memberDomain" = ${groupMetaMemberFeed.memberDomain}
                AND latest."memberAccount" = ${groupMetaMemberFeed.memberAccount}
                AND latest."feedId" <= ${scanEnd}
            )`,
          )
        : undefined;
    const result = await this.database.db
      .select()
      .from(groupMetaMemberFeed)
      .where(
        and(
          eq(groupMetaMemberFeed.targetPeerDomain, peerDomain),
          eq(groupMetaMemberFeed.groupId, source.groupId),
          sql`${groupMetaMemberFeed.feedId} > ${after}`,
          lte(groupMetaMemberFeed.feedId, scanEnd),
          modeFilter,
        ),
      )
      .orderBy(asc(groupMetaMemberFeed.feedId))
      .limit(limit);
    const hasMore = result.length > take;
    const pageRows = hasMore ? result.slice(0, take) : result;
    const scannedThrough = hasMore ? BigInt(pageRows.at(-1)!.feedId) : scanEnd;
    return {
      account,
      mode,
      items: pageRows.map((row): GroupMetaFeedItem => {
        const item = {
          feedId: row.feedId.toString(),
          account: row.memberAccount,
          domain: row.memberDomain,
        };
        return row.operation === 'UPSERT'
          ? {
              ...item,
              operation: 'UPSERT',
              body: row.body as Record<string, unknown>,
            }
          : {
              ...item,
              operation: 'DEPART',
              body: row.body as Record<string, never>,
            };
      }),
      scannedThrough: scannedThrough.toString(),
      groupMetaFeedEndId: end.toString(),
      hasMore,
    };
  }
}
