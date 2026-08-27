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
  ): Promise<{ groupId: number; account: string }> {
    const rows = await this.database.db.execute<{
      groupId: number;
      account: string;
    }>(sql`
      SELECT group_state.id AS "groupId", group_state.account
      FROM "MessageThread" thread
      JOIN "Group" group_state ON group_state.id = thread."groupId"
      JOIN "User" local_user ON local_user.id = ${userId}
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
    groupId: number,
    members: readonly ClientGroupMetaMemberWrite[],
  ): Promise<bigint> {
    await tx
      .insert(clientGroupMetaFeedTarget)
      .values({ accountId: userId, groupId, active: true })
      .onConflictDoUpdate({
        target: [
          clientGroupMetaFeedTarget.accountId,
          clientGroupMetaFeedTarget.groupId,
        ],
        set: { active: true, updatedAt: new Date() },
      });
    const locked = await tx.execute<{ allocatedThrough: bigint }>(sql`
      SELECT "allocatedThrough"
      FROM "ClientGroupMetaFeedTarget"
      WHERE "accountId" = ${userId} AND "groupId" = ${groupId}
      FOR UPDATE
    `);
    let allocatedThrough = BigInt(locked.rows[0]?.allocatedThrough ?? 0);
    const history = await tx
      .select()
      .from(clientGroupMetaMemberFeed)
      .where(
        and(
          eq(clientGroupMetaMemberFeed.accountId, userId),
          eq(clientGroupMetaMemberFeed.groupId, groupId),
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
      const key = `${previous.memberDomain}\u0000${previous.memberAccount}`;
      if (previous.operation !== 'UPSERT' || desired.has(key)) continue;
      changes.push({
        account: previous.memberAccount,
        domain: previous.memberDomain,
        operation: 'DEPART',
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
          accountId: userId,
          groupId,
          feedId: ++allocatedThrough,
          memberAccount: change.account,
          memberDomain: change.domain,
          operation: change.operation,
          body: change.body,
        })),
      );
      await tx
        .update(clientGroupMetaFeedTarget)
        .set({ allocatedThrough, updatedAt: new Date() })
        .where(
          and(
            eq(clientGroupMetaFeedTarget.accountId, userId),
            eq(clientGroupMetaFeedTarget.groupId, groupId),
          ),
        );
    }
    return allocatedThrough;
  }

  async serve(
    userId: number,
    groupId: number,
    account: string,
    mode: 'full' | 'delta',
    after: bigint,
    take: number,
    through?: bigint,
  ) {
    const target =
      await this.database.db.query.clientGroupMetaFeedTarget.findFirst({
        where: and(
          eq(clientGroupMetaFeedTarget.accountId, userId),
          eq(clientGroupMetaFeedTarget.groupId, groupId),
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
                eq(clientGroupMetaMemberFeed.accountId, userId),
                eq(clientGroupMetaMemberFeed.groupId, groupId),
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
              operation: 'UPSERT' | 'DEPART';
              body: unknown;
            }>(sql`
              SELECT latest.* FROM (
                SELECT DISTINCT ON ("memberDomain", "memberAccount")
                  "feedId", "memberAccount", "memberDomain", operation, body
                FROM "ClientGroupMetaMemberFeed"
                WHERE "accountId" = ${userId} AND "groupId" = ${groupId}
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
        operation: row.operation,
        body: row.body,
      })),
      scannedThrough: scannedThrough.toString(),
      groupMetaFeedEndId: end.toString(),
      hasMore,
    };
  }
}
