import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { serializeBody } from '../../common/serialize.interceptor.js';
import { groupMeta, groupMetaMemberFeed } from '../../database/schema.js';
import type { DatabaseTransaction } from '../../database/database.service.js';
import {
  groupState as group,
  groupStateFields,
} from '../shared/group-state.js';
import { upsertCurrentGroupMetaFactsInTx } from './current-group-meta-fact.js';

export interface GroupMetaMemberChange {
  account: string;
  domain: string;
  body: Record<string, unknown>;
  operation: 'MEMBER_UPSERT' | 'MEMBER_DEPART';
}

function memberKey(member: { domain: string; account: string }): string {
  return JSON.stringify([member.domain, member.account]);
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
        account: groupMetaMemberFeed.memberAccount,
        domain: groupMetaMemberFeed.memberDomain,
        operation: groupMetaMemberFeed.operation,
        body: groupMetaMemberFeed.body,
        feedId: groupMetaMemberFeed.feedId,
      })
      .from(groupMetaMemberFeed)
      .where(
        and(
          eq(groupMetaMemberFeed.threadId, groupId),
          or(
            ...members.map((member) =>
              and(
                eq(groupMetaMemberFeed.memberDomain, member.domain),
                eq(groupMetaMemberFeed.memberAccount, member.account),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(groupMetaMemberFeed.feedId));
    const current = new Map(
      history.map((item) => [memberKey(item), item] as const),
    );
    const changes = members
      .map((member) => ({
        ...member,
        body:
          member.operation === 'MEMBER_DEPART'
            ? {}
            : (serializeBody(member.body) as Record<string, unknown>),
      }))
      .filter((member) => {
        const previous = current.get(memberKey(member));
        return (
          previous?.operation !== member.operation ||
          !isDeepStrictEqual(previous.body, member.body)
        );
      })
      .sort(compareMembers);
    if (changes.length === 0) return metaEndId;
    await upsertCurrentGroupMetaFactsInTx(
      tx,
      changes.map((change) => ({
        threadId: groupId,
        feedId: ++metaEndId,
        memberAccount: change.account,
        memberDomain: change.domain,
        operation: change.operation,
        body: change.body,
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
    const body =
      member.operation === 'MEMBER_DEPART'
        ? {}
        : (serializeBody(member.body) as Record<string, unknown>);
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
          ("threadId", "feedId", "memberAccount", "memberDomain",
            operation, body)
        SELECT ${groupId}, coordinate."metaEndId", ${member.account},
          ${member.domain},
          ${member.operation}::"GroupMetaMemberOperation",
          ${JSON.stringify(body)}::jsonb
        FROM coordinate
        ON CONFLICT ("threadId", "memberAccount", "memberDomain")
        DO UPDATE SET "feedId" = EXCLUDED."feedId",
          "profileSourceSeq" = CASE
            WHEN "GroupMetaMemberFeed".operation = 'MEMBER_DEPART'
              AND EXCLUDED.operation = 'MEMBER_UPSERT' THEN NULL
            ELSE "GroupMetaMemberFeed"."profileSourceSeq" END,
          operation = EXCLUDED.operation, body = EXCLUDED.body,
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
        feedId: groupMeta.announcementFeedId,
        text: groupMeta.announcementText,
      })
      .from(groupMeta)
      .where(eq(groupMeta.threadId, groupId))
      .limit(1);
    if (!current) throw new Error('group meta feed is missing');
    if (current.feedId !== null && current.text === text)
      return { feedId: current.feedId, changed: false };
    const feedId = feed.metaEndId + 1;
    await tx
      .update(groupMeta)
      .set({
        metaEndId: feedId,
        announcementFeedId: feedId,
        announcementText: text,
        updatedAt: new Date(),
      })
      .where(eq(groupMeta.threadId, groupId));
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
        memberAccount: source.account,
        memberDomain: 'local',
        operation: 'GROUP_PROFILE',
        body: { profileRev },
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

function compareMembers(
  left: { domain: string; account: string },
  right: { domain: string; account: string },
): number {
  return (
    left.domain.localeCompare(right.domain) ||
    left.account.localeCompare(right.account)
  );
}
