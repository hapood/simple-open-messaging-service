import { HttpStatus, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  clientGroupMetaFeedTarget,
  clientGroupMetaMemberFeed,
} from '../database/schema.js';
import { mutuallyAuthorizedSql } from '../invite/relationship-authorization.js';

export interface ClientGroupMetaMemberWrite {
  account: string;
  domain: string;
  body: Record<string, unknown>;
}

@Injectable()
export class ClientGroupMetaFeedService {
  constructor(private readonly database: DatabaseService) {}

  async resolveVisibleGroup(
    userId: number,
    selector: { threadId?: number; account?: string; domain?: string },
  ): Promise<{ groupUserId: number; account: string }> {
    const rows = await this.database.db.execute<{
      groupUserId: number;
      account: string;
    }>(sql`
      SELECT thread."groupUserId" AS "groupUserId", group_user.account
      FROM "MessageThread" thread
      JOIN "User" group_user ON group_user.id = thread."groupUserId"
      JOIN "Group" group_state ON group_state."groupUserId" = thread."groupUserId"
      JOIN "ThreadParticipant" mine
        ON mine."threadId" = thread.id AND mine."userId" = ${userId}
      WHERE thread.type = 'GROUP'
        AND (${userId} = group_state."ownerId"
          OR ${mutuallyAuthorizedSql(userId, sql`thread."groupUserId"`)})
        AND (${selector.threadId ?? null}::integer IS NULL OR thread.id = ${selector.threadId ?? null})
        AND (${selector.account ?? null}::text IS NULL OR group_user.account = ${selector.account ?? null})
        AND (${selector.domain ?? null}::text IS NULL OR group_user.domain = ${selector.domain ?? null})
      LIMIT 1
    `);
    const resolved = rows.rows[0];
    if (!resolved)
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'group meta is not visible to this user',
        HttpStatus.FORBIDDEN,
      );
    return resolved;
  }

  async reconcileInTx(
    tx: DatabaseTransaction,
    userId: number,
    groupUserId: number,
    members: readonly ClientGroupMetaMemberWrite[],
  ): Promise<bigint> {
    await tx
      .insert(clientGroupMetaFeedTarget)
      .values({ userId, groupUserId, active: true })
      .onConflictDoUpdate({
        target: [
          clientGroupMetaFeedTarget.userId,
          clientGroupMetaFeedTarget.groupUserId,
        ],
        set: { active: true, updatedAt: new Date() },
      });
    const locked = await tx.execute<{ allocatedThrough: bigint }>(sql`
      SELECT "allocatedThrough"
      FROM "ClientGroupMetaFeedTarget"
      WHERE "userId" = ${userId} AND "groupUserId" = ${groupUserId}
      FOR UPDATE
    `);
    let allocatedThrough = BigInt(locked.rows[0]?.allocatedThrough ?? 0);
    const history = await tx
      .select()
      .from(clientGroupMetaMemberFeed)
      .where(
        and(
          eq(clientGroupMetaMemberFeed.userId, userId),
          eq(clientGroupMetaMemberFeed.groupUserId, groupUserId),
        ),
      )
      .orderBy(asc(clientGroupMetaMemberFeed.feedId));
    const current = new Map(
      history.map((item) => [
        `${item.memberDomain}\u0000${item.memberAccount}`,
        item,
      ]),
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
      memberRev: number;
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
        memberRev: (previous?.memberRev ?? 0) + 1,
        operation: 'UPSERT',
        body: member.body,
      });
    }
    for (const previous of current.values()) {
      const key = `${previous.memberDomain}\u0000${previous.memberAccount}`;
      if (previous.operation !== 'UPSERT' || desired.has(key)) continue;
      changes.push({
        account: previous.memberAccount,
        domain: previous.memberDomain,
        memberRev: previous.memberRev + 1,
        operation: 'DELETE',
        body: {},
      });
    }
    changes.sort(
      (a, b) =>
        a.domain.localeCompare(b.domain) || a.account.localeCompare(b.account),
    );
    if (changes.length) {
      await tx.insert(clientGroupMetaMemberFeed).values(
        changes.map((change) => ({
          userId,
          groupUserId,
          feedId: ++allocatedThrough,
          memberAccount: change.account,
          memberDomain: change.domain,
          memberRev: change.memberRev,
          operation: change.operation,
          body: change.body,
        })),
      );
      await tx
        .update(clientGroupMetaFeedTarget)
        .set({ allocatedThrough, updatedAt: new Date() })
        .where(
          and(
            eq(clientGroupMetaFeedTarget.userId, userId),
            eq(clientGroupMetaFeedTarget.groupUserId, groupUserId),
          ),
        );
    }
    return allocatedThrough;
  }

  async serve(
    userId: number,
    groupUserId: number,
    account: string,
    mode: 'full' | 'delta',
    after: bigint,
    take: number,
    through?: bigint,
  ) {
    const target =
      await this.database.db.query.clientGroupMetaFeedTarget.findFirst({
        where: and(
          eq(clientGroupMetaFeedTarget.userId, userId),
          eq(clientGroupMetaFeedTarget.groupUserId, groupUserId),
          eq(clientGroupMetaFeedTarget.active, true),
        ),
      });
    if (!target)
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'group meta is not visible to this user',
        HttpStatus.FORBIDDEN,
      );
    const end = target.allocatedThrough;
    if (
      after < 0n ||
      (through !== undefined && through < after) ||
      !Number.isSafeInteger(take) ||
      take < 1 ||
      take > 200
    )
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid group-meta cursor or page size',
        HttpStatus.BAD_REQUEST,
      );
    if (
      after > end ||
      (mode === 'delta' && after < target.oldestAvailableAfter)
    )
      throw new BusinessException(
        BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
        'group meta cursor is outside the available coordinate space',
        HttpStatus.OK,
        { resumeAfter: '0', resumeBefore: (end + 1n).toString() },
      );
    const scanEnd = through === undefined || through > end ? end : through;
    const limit = take + 1;
    const rows =
      mode === 'delta'
        ? await this.database.db
            .select()
            .from(clientGroupMetaMemberFeed)
            .where(
              and(
                eq(clientGroupMetaMemberFeed.userId, userId),
                eq(clientGroupMetaMemberFeed.groupUserId, groupUserId),
                sql`${clientGroupMetaMemberFeed.feedId} > ${after}`,
                lte(clientGroupMetaMemberFeed.feedId, scanEnd),
              ),
            )
            .orderBy(asc(clientGroupMetaMemberFeed.feedId))
            .limit(limit)
        : (
            await this.database.db.execute<{
              feedId: bigint;
              memberAccount: string;
              memberDomain: string;
              memberRev: number;
              operation: 'UPSERT' | 'DELETE';
              body: unknown;
            }>(sql`
              SELECT latest.* FROM (
                SELECT DISTINCT ON ("memberDomain", "memberAccount")
                  "feedId", "memberAccount", "memberDomain", "memberRev", operation, body
                FROM "ClientGroupMetaMemberFeed"
                WHERE "userId" = ${userId} AND "groupUserId" = ${groupUserId}
                  AND "feedId" <= ${scanEnd}
                ORDER BY "memberDomain", "memberAccount", "feedId" DESC
              ) latest
              WHERE latest.operation = 'UPSERT' AND latest."feedId" > ${after}
              ORDER BY latest."feedId" LIMIT ${limit}
            `)
          ).rows;
    const hasMore = rows.length > take;
    const pageRows = hasMore ? rows.slice(0, take) : rows;
    const scannedThrough = hasMore ? BigInt(pageRows.at(-1)!.feedId) : scanEnd;
    return {
      account,
      mode,
      items: pageRows.map((row) => ({
        feedId: row.feedId.toString(),
        account: row.memberAccount,
        domain: row.memberDomain,
        rev: row.memberRev,
        operation: row.operation,
        body: row.body,
      })),
      scannedThrough: scannedThrough.toString(),
      groupMetaFeedEndId: end.toString(),
      hasMore,
    };
  }
}
