import { groupState as group, groupStateFields } from '../group/group-state.js';
import { HttpStatus, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import {
  groupMetaFeed,
  groupMetaMemberFeed,
  groupMetaProfileFeed,
  threadAudience,
} from '../database/schema.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { readGroupMetaPageInTx } from '../group-meta/group-meta-page.js';
import { loadFederationConfig } from './federation.config.js';
import { resolveAuthorizedFederationThreadInTx } from './federation-thread-query-authorization.js';

export interface GroupMetaMemberWrite {
  namespaceId: number;
  account: string;
  domain: string;
  body: Record<string, unknown>;
}

export interface GroupMetaMemberChange extends GroupMetaMemberWrite {
  operation: 'UPSERT' | 'DEPART';
}

interface GroupMetaFeedItemBase {
  feedId: string;
  account: string;
  domain: string;
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

const DEFAULT_TAKE = 100;

function memberKey(member: { domain: string; account: string }): string {
  return JSON.stringify([member.domain, member.account]);
}

@Injectable()
export class GroupMetaFeedService {
  private readonly ourDomain = loadFederationConfig().domain;

  constructor(private readonly database: DatabaseService) {}

  async resolveAllocatedMemberProfile(
    peerDomain: string,
    namespaceId: number,
    groupAccount: string,
    memberAccount: string,
    memberDomain: string,
    profileRev: number,
  ): Promise<{ memberNamespaceId: number } | null> {
    try {
      return await this.database.db.transaction(
        async (tx) => {
          const authorized = await resolveAuthorizedFederationThreadInTx(
            tx,
            peerDomain,
            namespaceId,
            { type: 'GROUP', account: groupAccount },
          );
          if (authorized.groupQueryDirection !== 'ORIGIN_DISTRIBUTION')
            return null;
          const [source] = await tx
            .select({ groupId: group.id })
            .from(group)
            .where(
              and(
                eq(groupStateFields.account, groupAccount),
                eq(groupStateFields.domain, 'local'),
                eq(groupStateFields.namespaceId, 0),
              ),
            )
            .limit(1);
          if (!source) return null;
          const storedMemberDomain =
            memberDomain === this.ourDomain ? 'local' : memberDomain;
          const rows = await tx.execute<{ memberNamespaceId: number }>(sql`
          SELECT latest."memberNamespaceId"
          FROM (
            SELECT member_fact."memberNamespaceId", member_fact.operation, member_fact.body
            FROM "GroupMetaMemberFeed" member_fact
            WHERE member_fact."threadId" = ${source.groupId}
              AND member_fact."memberAccount" = ${memberAccount}
              AND member_fact."memberDomain" = ${storedMemberDomain}
            ORDER BY member_fact."feedId" DESC
            LIMIT 1
          ) latest
          WHERE latest.operation = 'UPSERT'
            AND latest.body ->> 'profileRev' = ${profileRev.toString()}
        `);
          return rows.rows[0] ?? null;
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    } catch (error) {
      if (
        error instanceof BusinessException &&
        error.bizCode === BusinessCode.FORBIDDEN
      )
        return null;
      throw error;
    }
  }

  async reconcileMembersInTx(
    tx: DatabaseTransaction,
    groupId: number,
    members: readonly GroupMetaMemberChange[],
  ): Promise<bigint> {
    if (members.length === 0)
      throw new Error('group meta member projection is empty');
    let feedEndId = await this.lockFeedInTx(tx, groupId);
    const history = await tx
      .select({
        account: groupMetaMemberFeed.memberAccount,
        domain: groupMetaMemberFeed.memberDomain,
        namespaceId: groupMetaMemberFeed.memberNamespaceId,
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
          member.operation === 'DEPART'
            ? {}
            : (serializeBody(member.body) as Record<string, unknown>),
      }))
      .filter((member) => {
        const previous = current.get(memberKey(member));
        return (
          previous?.namespaceId !== member.namespaceId ||
          previous?.operation !== member.operation ||
          !isDeepStrictEqual(previous.body, member.body)
        );
      })
      .sort(compareMembers);
    if (changes.length === 0) return feedEndId;
    await tx.insert(groupMetaMemberFeed).values(
      changes.map((change) => ({
        threadId: groupId,
        feedId: ++feedEndId,
        memberAccount: change.account,
        memberDomain: change.domain,
        memberNamespaceId: change.namespaceId,
        operation: change.operation,
        body: change.body,
        updatedAt: new Date(),
      })),
    );
    await this.advanceFeedInTx(tx, groupId, feedEndId);
    return feedEndId;
  }

  async reconcileProfileInTx(
    tx: DatabaseTransaction,
    groupId: number,
    profileRev: number,
  ): Promise<bigint> {
    let feedEndId = await this.lockFeedInTx(tx, groupId);
    const [current] = await tx
      .select({ profileRev: groupMetaProfileFeed.profileRev })
      .from(groupMetaProfileFeed)
      .where(eq(groupMetaProfileFeed.threadId, groupId))
      .limit(1);
    if (current?.profileRev === profileRev) return feedEndId;
    feedEndId += 1n;
    await tx
      .insert(groupMetaProfileFeed)
      .values({ threadId: groupId, feedId: feedEndId, profileRev })
      .onConflictDoUpdate({
        target: groupMetaProfileFeed.threadId,
        set: { feedId: feedEndId, profileRev, updatedAt: new Date() },
      });
    await this.advanceFeedInTx(tx, groupId, feedEndId);
    return feedEndId;
  }

  async reconcileInTx(
    tx: DatabaseTransaction,
    groupId: number,
    profileRev: number,
    members: readonly GroupMetaMemberWrite[],
  ): Promise<bigint> {
    let feedEndId = await this.lockFeedInTx(tx, groupId);
    const history = await tx
      .select({
        account: groupMetaMemberFeed.memberAccount,
        domain: groupMetaMemberFeed.memberDomain,
        namespaceId: groupMetaMemberFeed.memberNamespaceId,
        operation: groupMetaMemberFeed.operation,
        body: groupMetaMemberFeed.body,
      })
      .from(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.threadId, groupId))
      .orderBy(asc(groupMetaMemberFeed.feedId));
    const current = new Map(
      history.map((item) => [memberKey(item), item] as const),
    );
    const desired = new Map(
      members.map((member) => [
        memberKey(member),
        {
          ...member,
          body: serializeBody(member.body) as Record<string, unknown>,
        },
      ]),
    );
    const changes: GroupMetaMemberChange[] = [];
    for (const [key, member] of desired) {
      const previous = current.get(key);
      if (
        previous?.operation === 'UPSERT' &&
        previous.namespaceId === member.namespaceId &&
        isDeepStrictEqual(previous.body, member.body)
      )
        continue;
      changes.push({ ...member, operation: 'UPSERT' });
    }
    for (const previous of current.values()) {
      if (previous.operation !== 'UPSERT' || desired.has(memberKey(previous)))
        continue;
      changes.push({
        account: previous.account,
        domain: previous.domain,
        namespaceId: previous.namespaceId,
        operation: 'DEPART',
        body: {},
      });
    }
    changes.sort(compareMembers);
    if (changes.length > 0) {
      await tx.insert(groupMetaMemberFeed).values(
        changes.map((change) => ({
          threadId: groupId,
          feedId: ++feedEndId,
          memberAccount: change.account,
          memberDomain: change.domain,
          memberNamespaceId: change.namespaceId,
          operation: change.operation,
          body: change.operation === 'DEPART' ? {} : change.body,
          updatedAt: new Date(),
        })),
      );
    }
    const [currentProfile] = await tx
      .select({ profileRev: groupMetaProfileFeed.profileRev })
      .from(groupMetaProfileFeed)
      .where(eq(groupMetaProfileFeed.threadId, groupId))
      .limit(1);
    if (currentProfile?.profileRev !== profileRev) {
      feedEndId += 1n;
      await tx
        .insert(groupMetaProfileFeed)
        .values({ threadId: groupId, feedId: feedEndId, profileRev })
        .onConflictDoUpdate({
          target: groupMetaProfileFeed.threadId,
          set: { feedId: feedEndId, profileRev, updatedAt: new Date() },
        });
    }
    await this.advanceFeedInTx(tx, groupId, feedEndId);
    return feedEndId;
  }

  private async lockFeedInTx(
    tx: DatabaseTransaction,
    groupId: number,
  ): Promise<bigint> {
    await tx
      .insert(groupMetaFeed)
      .values({ threadId: groupId })
      .onConflictDoNothing({ target: groupMetaFeed.threadId });
    const locked = await tx.execute<{ feedEndId: string }>(sql`
      SELECT "feedEndId"
      FROM "GroupMetaFeed"
      WHERE "threadId" = ${groupId}
      FOR NO KEY UPDATE
    `);
    const feed = locked.rows[0];
    if (!feed) throw new Error('group meta feed is missing');
    return BigInt(feed.feedEndId);
  }

  private async advanceFeedInTx(
    tx: DatabaseTransaction,
    groupId: number,
    feedEndId: bigint,
  ): Promise<void> {
    await tx
      .update(groupMetaFeed)
      .set({ feedEndId, updatedAt: new Date() })
      .where(eq(groupMetaFeed.threadId, groupId));
  }

  async serve(
    peerDomain: string,
    namespaceId: number,
    account: string,
    mode: 'full' | 'delta',
    after: bigint | undefined,
    take = DEFAULT_TAKE,
    through?: bigint,
  ): Promise<GroupMetaFeedPage> {
    return this.database.db.transaction(
      async (tx) => {
        const authorized = await resolveAuthorizedFederationThreadInTx(
          tx,
          peerDomain,
          namespaceId,
          { type: 'GROUP', account },
        );
        if (authorized.groupQueryDirection !== 'ORIGIN_DISTRIBUTION')
          throw new BusinessException(
            BusinessCode.FORBIDDEN,
            'group meta is not visible to this peer',
            HttpStatus.OK,
          );
        const [source] = await tx
          .select({ groupId: group.id })
          .from(group)
          .where(
            and(
              eq(groupStateFields.account, account),
              eq(groupStateFields.domain, 'local'),
              eq(groupStateFields.namespaceId, 0),
            ),
          )
          .limit(1);
        if (!source)
          throw new BusinessException(
            BusinessCode.FORBIDDEN,
            'group meta is not visible to this peer',
            HttpStatus.OK,
          );
        const [feed] = await tx
          .select({ feedEndId: groupMetaFeed.feedEndId })
          .from(groupMetaFeed)
          .where(eq(groupMetaFeed.threadId, source.groupId))
          .limit(1);
        const [audience] = await tx
          .select({ visibleAfter: threadAudience.groupMetaVisibleAfter })
          .from(threadAudience)
          .where(
            and(
              eq(threadAudience.threadId, authorized.threadId),
              eq(threadAudience.targetDomain, peerDomain),
              eq(threadAudience.targetNamespaceId, namespaceId),
              sql`${threadAudience.localUserId} IS NULL`,
            ),
          )
          .limit(1);
        const page = await readGroupMetaPageInTx(tx, {
          groupId: source.groupId,
          account,
          mode,
          after,
          take,
          through,
          end: feed?.feedEndId ?? 0n,
          visibleAfter: audience?.visibleAfter ?? 0n,
        });
        return {
          ...page,
          items: page.items.map((item) =>
            'domain' in item && item.domain === 'local'
              ? { ...item, domain: this.ourDomain }
              : item,
          ),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
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
