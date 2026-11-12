import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, sql } from 'drizzle-orm';
import { serializeBody } from '../../common/serialize.interceptor.js';
import { groupMeta, groupMetaMemberFeed } from '../../database/schema.js';
import type { DatabaseTransaction } from '../../database/database.service.js';
import {
  groupState as group,
  groupStateFields,
} from '../shared/group-state.js';
import { upsertCurrentGroupMetaFactsInTx } from './current-group-meta-fact.js';

/** A member fact body in the new unified shape: the subject identity
 * (account + publisher-coordinate namespaceId) lives inside the body. */
export interface GroupMetaMemberChange {
  account: string;
  profileNamespaceId: number;
  operation: 'MEMBER_UPSERT' | 'MEMBER_DEPART';
  role: import('../../database/enums.js').GroupRole;
  profileRev: number;
}

function memberKey(member: { account: string; namespaceId: number }): string {
  return JSON.stringify([member.namespaceId, member.account]);
}

function memberFactBody(
  member: GroupMetaMemberChange,
): Record<string, unknown> {
  return serializeBody({
    account: member.account,
    namespaceId: member.profileNamespaceId,
    role: member.role,
    profileRev: member.profileRev,
  }) as Record<string, unknown>;
}

@Injectable()
export class GroupMetaFeedService {
  async reconcileMembersInTx(
    tx: DatabaseTransaction,
    groupId: number,
    members: readonly GroupMetaMemberChange[],
  ): Promise<number> {
    if (members.length === 0)
      throw new Error('group meta member projection is empty');
    const locked = await this.lockFeedInTx(tx, groupId);
    let metaEndId = locked.metaEndId;
    const history = await tx
      .select({
        body: groupMetaMemberFeed.body,
        operation: groupMetaMemberFeed.operation,
        feedId: groupMetaMemberFeed.feedId,
      })
      .from(groupMetaMemberFeed)
      .where(
        and(
          eq(groupMetaMemberFeed.threadId, groupId),
          sql`${groupMetaMemberFeed.body} ->> 'account' IN (${sql.join(
            members.map((member) => sql`${member.account}`),
            sql`, `,
          )})`,
        ),
      )
      .orderBy(asc(groupMetaMemberFeed.feedId));
    const current = new Map(
      history
        .filter((item) => typeof item.body.account === 'string')
        .map(
          (item) =>
            [
              memberKey({
                account: item.body.account as string,
                namespaceId: Number(item.body.namespaceId),
              }),
              item,
            ] as const,
        ),
    );
    const changes = members.filter((member) => {
      const previous = current.get(
        memberKey({
          account: member.account,
          namespaceId: member.profileNamespaceId,
        }),
      );
      const body = memberFactBody(member);
      return (
        previous?.operation !== member.operation ||
        !isDeepStrictEqual(previous.body, body)
      );
    });
    if (changes.length === 0) return metaEndId;
    await upsertCurrentGroupMetaFactsInTx(
      tx,
      changes.map((change) => ({
        threadId: groupId,
        feedId: ++metaEndId,
        operation: change.operation,
        body: memberFactBody(change),
        updatedAt: new Date(),
      })),
    );
    await this.advanceFeedInTx(tx, groupId, metaEndId, locked.profileRev);
    return metaEndId;
  }

  /** Publish a membership transition already established by RelationshipPair.
   * A previous identical roster row cannot suppress this coordinate: the pair
   * may have changed while the projection was stale. */
  async appendMemberTransitionInTx(
    tx: DatabaseTransaction,
    groupId: number,
    member: GroupMetaMemberChange,
  ): Promise<number> {
    const body = memberFactBody(member);
    const allocation = await tx.execute<{ metaEndId: number }>(sql`
      WITH coordinate AS (
        INSERT INTO "GroupMeta" ("threadId", "metaEndId")
        VALUES (${groupId}, 1)
        ON CONFLICT ("threadId") DO UPDATE SET
          "metaEndId" = "GroupMeta"."metaEndId" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        RETURNING "metaEndId"
      ), member_fact AS (
        INSERT INTO "GroupMetaMemberFeed"
          ("threadId", "feedId", operation, body)
        SELECT ${groupId}, coordinate."metaEndId",
          ${member.operation}::"GroupMetaMemberOperation",
          ${JSON.stringify(body)}::jsonb
        FROM coordinate
        ON CONFLICT ("threadId", (body ->> 'account'),
            (body -> 'namespaceId'))
          WHERE operation <> 'GROUP_ANNOUNCEMENT'
        DO UPDATE SET "feedId" = EXCLUDED."feedId",
          "profileSourceSeq" = CASE
            WHEN "GroupMetaMemberFeed".operation = 'MEMBER_DEPART'
              AND EXCLUDED.operation = 'MEMBER_UPSERT' THEN NULL
            ELSE "GroupMetaMemberFeed"."profileSourceSeq" END,
          operation = EXCLUDED.operation, body = EXCLUDED.body,
          "createdAt" = EXCLUDED."createdAt", "originCreatedAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
        RETURNING "feedId"
      )
      SELECT "feedId" AS "metaEndId" FROM member_fact
    `);
    const metaEndId = allocation.rows[0]?.metaEndId;
    if (metaEndId === undefined)
      throw new Error('group meta member coordinate was not allocated');
    return metaEndId;
  }

  /** Replace the one canonical group-wide announcement without allocating a
   * message sequence. Callers hold the group mutation and thread-content locks
   * and publish the resulting head in the same transaction. */
  async reconcileAnnouncementInTx(
    tx: DatabaseTransaction,
    groupId: number,
    text: string | null,
  ): Promise<{ feedId: number; changed: boolean }> {
    const feed = await this.lockFeedInTx(tx, groupId);
    const [current] = await tx
      .select({
        feedId: groupMetaMemberFeed.feedId,
        body: groupMetaMemberFeed.body,
      })
      .from(groupMetaMemberFeed)
      .where(
        and(
          eq(groupMetaMemberFeed.threadId, groupId),
          eq(groupMetaMemberFeed.operation, 'GROUP_ANNOUNCEMENT'),
        ),
      )
      .limit(1);
    if (current && current.body.text === text)
      return { feedId: current.feedId, changed: false };
    const feedId = feed.metaEndId + 1;
    await upsertCurrentGroupMetaFactsInTx(tx, [
      {
        threadId: groupId,
        feedId,
        operation: 'GROUP_ANNOUNCEMENT',
        body: { text },
      },
    ]);
    await this.advanceFeedInTx(tx, groupId, feedId, feed.profileRev);
    return { feedId, changed: true };
  }

  async reconcileProfileInTx(
    tx: DatabaseTransaction,
    groupId: number,
    profileRev: number,
  ): Promise<number> {
    const feed = await this.lockFeedInTx(tx, groupId);
    if (feed.profileRev === profileRev) return feed.metaEndId;
    const metaEndId = feed.metaEndId + 1;
    const [source] = await tx
      .select({ account: groupStateFields.account })
      .from(group)
      .where(eq(groupStateFields.id, groupId))
      .limit(1);
    if (!source) throw new Error('authoritative group profile is missing');
    await upsertCurrentGroupMetaFactsInTx(tx, [
      {
        threadId: groupId,
        feedId: metaEndId,
        operation: 'GROUP_PROFILE',
        body: { account: source.account, namespaceId: 0, profileRev },
        updatedAt: new Date(),
      },
    ]);
    await this.advanceFeedInTx(tx, groupId, metaEndId, profileRev);
    return metaEndId;
  }

  private async lockFeedInTx(
    tx: DatabaseTransaction,
    groupId: number,
  ): Promise<{ metaEndId: number; profileRev: number }> {
    await tx
      .insert(groupMeta)
      .values({ threadId: groupId })
      .onConflictDoNothing({ target: groupMeta.threadId });
    const locked = await tx.execute<{
      metaEndId: number;
      profileRev: number;
    }>(sql`
      SELECT "metaEndId", "profileRev"
      FROM "GroupMeta"
      WHERE "threadId" = ${groupId}
      FOR NO KEY UPDATE
    `);
    const feed = locked.rows[0];
    if (!feed) throw new Error('group meta feed is missing');
    return { metaEndId: feed.metaEndId, profileRev: feed.profileRev };
  }

  private async advanceFeedInTx(
    tx: DatabaseTransaction,
    groupId: number,
    metaEndId: number,
    profileRev: number,
  ): Promise<void> {
    await tx
      .update(groupMeta)
      .set({ metaEndId, profileRev, updatedAt: new Date() })
      .where(eq(groupMeta.threadId, groupId));
  }
}
