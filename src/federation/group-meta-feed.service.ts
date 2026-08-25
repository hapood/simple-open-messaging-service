import { HttpStatus, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import {
  groupMetaFeedTarget,
  groupMetaMemberFeed,
  user,
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

export interface GroupMetaFeedItem {
  feedId: string;
  account: string;
  domain: string;
  operation: 'UPSERT' | 'DELETE';
  body: unknown;
}

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
    groupUserId: number,
  ): Promise<void> {
    await tx
      .update(groupMetaFeedTarget)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(groupMetaFeedTarget.targetPeerDomain, targetPeerDomain),
          eq(groupMetaFeedTarget.groupUserId, groupUserId),
        ),
      );
  }

  async reconcileInTx(
    tx: DatabaseTransaction,
    targetPeerDomain: string,
    groupUserId: number,
    members: readonly GroupMetaMemberWrite[],
  ): Promise<bigint> {
    await tx
      .insert(groupMetaFeedTarget)
      .values({ targetPeerDomain, groupUserId, active: true })
      .onConflictDoUpdate({
        target: [
          groupMetaFeedTarget.targetPeerDomain,
          groupMetaFeedTarget.groupUserId,
        ],
        set: { active: true, updatedAt: new Date() },
      });
    const locked = await tx.execute<{ allocatedThrough: bigint }>(sql`
      SELECT "allocatedThrough"
      FROM "GroupMetaFeedTarget"
      WHERE "targetPeerDomain" = ${targetPeerDomain}
        AND "groupUserId" = ${groupUserId}
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
          eq(groupMetaMemberFeed.groupUserId, groupUserId),
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
      operation: 'UPSERT' | 'DELETE';
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
        operation: 'DELETE',
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
          groupUserId,
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
            eq(groupMetaFeedTarget.groupUserId, groupUserId),
          ),
        );
    }
    return allocatedThrough;
  }

  async serve(
    peerDomain: string,
    account: string,
    mode: 'full' | 'delta',
    after: bigint,
    take = DEFAULT_TAKE,
    through?: bigint,
  ): Promise<GroupMetaFeedPage> {
    const [source] = await this.database.db
      .select({
        groupUserId: user.id,
        allocatedThrough: groupMetaFeedTarget.allocatedThrough,
        oldestAvailableAfter: groupMetaFeedTarget.oldestAvailableAfter,
      })
      .from(user)
      .innerJoin(
        groupMetaFeedTarget,
        and(
          eq(groupMetaFeedTarget.groupUserId, user.id),
          eq(groupMetaFeedTarget.targetPeerDomain, peerDomain),
        ),
      )
      .where(
        and(
          eq(user.account, account),
          eq(user.domain, 'local'),
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
        {
          resumeAfter: '0',
          resumeBefore: (end + 1n).toString(),
        },
      );
    const scanEnd = through === undefined || through > end ? end : through;
    const limit = take + 1;
    const result =
      mode === 'delta'
        ? await this.database.db
            .select()
            .from(groupMetaMemberFeed)
            .where(
              and(
                eq(groupMetaMemberFeed.targetPeerDomain, peerDomain),
                eq(groupMetaMemberFeed.groupUserId, source.groupUserId),
                sql`${groupMetaMemberFeed.feedId} > ${after}`,
                lte(groupMetaMemberFeed.feedId, scanEnd),
              ),
            )
            .orderBy(asc(groupMetaMemberFeed.feedId))
            .limit(limit)
        : (
            await this.database.db.execute<{
              feedId: bigint;
              memberAccount: string;
              memberDomain: string;
              operation: 'UPSERT' | 'DELETE';
              body: unknown;
            }>(sql`
              SELECT latest.*
              FROM (
                SELECT DISTINCT ON ("memberDomain", "memberAccount")
                  "feedId", "memberAccount", "memberDomain", "operation", "body"
                FROM "GroupMetaMemberFeed"
                WHERE "targetPeerDomain" = ${peerDomain}
                  AND "groupUserId" = ${source.groupUserId}
                  AND "feedId" <= ${scanEnd}
                ORDER BY "memberDomain", "memberAccount", "feedId" DESC
              ) latest
              WHERE latest."operation" = 'UPSERT'
                AND latest."feedId" > ${after}
              ORDER BY latest."feedId"
              LIMIT ${limit}
            `)
          ).rows;
    const hasMore = result.length > take;
    const pageRows = hasMore ? result.slice(0, take) : result;
    const scannedThrough = hasMore ? BigInt(pageRows.at(-1)!.feedId) : scanEnd;
    return {
      account,
      mode,
      items: pageRows.map((row) => ({
        feedId: row.feedId.toString(),
        account: row.memberAccount,
        domain: row.memberDomain,
        operation: row.operation,
        body: row.body,
      })),
      scannedThrough: scannedThrough.toString(),
      groupMetaFeedEndId: end.toString(),
      hasMore,
    };
  }
}
