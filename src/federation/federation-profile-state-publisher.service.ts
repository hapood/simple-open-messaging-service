import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { PendingClientStateFeedUpdate } from '../client-state-feed/client-state-feed.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole, MessageThreadType } from '../database/enums.js';
import * as tables from '../database/schema.js';
import {
  isThreadMutuallyAuthorized,
  mutuallyAuthorizedSql,
} from '../invite/relationship-authorization.js';
import { UploadService } from '../upload/upload.service.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationThreadContentHeadService } from './federation-thread-content-head.service.js';
import { GroupMetaFeedService } from './group-meta-feed.service.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';

@Injectable()
export class FederationProfileStatePublisher {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly upload: UploadService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly threadContentHeads: FederationThreadContentHeadService,
    @Optional() private readonly groupMetaFeed?: GroupMetaFeedService,
  ) {}

  async writeProfileStateInTx(
    tx: DatabaseTransaction,
    userId: number,
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const [user] = await tx
      .select({
        account: tables.user.account,
        name: tables.user.name,
        avatar: tables.user.avatar,
        bio: tables.user.bio,
        profileRev: tables.user.profileRev,
      })
      .from(tables.user)
      .where(and(eq(tables.user.id, userId), eq(tables.user.domain, 'local')))
      .limit(1);
    if (!user) return new Map();
    const avatar = await this.readAvatar(user.avatar);
    const peers = await tx.execute<{ domain: string }>(sql`
      SELECT DISTINCT peer_user.domain
      FROM "ThreadMember" mine
      JOIN "MessageThread" thread ON thread.id = mine."threadId" AND thread.type = 'P2P'
      JOIN "ThreadMember" peer_part ON peer_part."threadId" = mine."threadId"
      JOIN "User" peer_user ON peer_user.id = peer_part."userId"
      WHERE mine."userId" = ${userId}
        AND ${mutuallyAuthorizedSql(userId, sql`peer_part."userId"`)}
        AND peer_user.domain <> 'local'
    `);
    const directProfiles = await this.stateFeed.writeManyInTx(
      tx,
      peers.rows.map(({ domain }) => ({
        peerDomain: domain,
        account: user.account,
        domain: this.config.domain,
        eventType: 'PROFILE' as const,
        subjectAccount: '',
        subjectDomain: 'local',
        body: {
          profileRev: user.profileRev,
          displayName: user.name,
          bio: user.bio,
          avatar,
        },
      })),
    );
    const originGroups = await tx
      .select({ threadId: tables.threadMember.threadId })
      .from(tables.threadMember)
      .innerJoin(
        tables.messageThread,
        eq(tables.messageThread.id, tables.threadMember.threadId),
      )
      .innerJoin(
        tables.group,
        eq(tables.group.id, tables.messageThread.groupId),
      )
      .where(
        and(
          eq(tables.threadMember.userId, userId),
          eq(tables.messageThread.type, MessageThreadType.GROUP),
          eq(tables.group.domain, 'local'),
        ),
      );
    const result = new Map(directProfiles);
    for (const group of originGroups) {
      if (!(await isThreadMutuallyAuthorized(tx, userId, group.threadId)))
        continue;
      const state = await this.writeGroupStateInTx(
        tx,
        group.threadId,
        clientFeedUpdates,
      );
      for (const entry of state) result.set(...entry);
    }
    return result;
  }

  async writeUserProfileToPeerInTx(
    tx: DatabaseTransaction,
    userId: number,
    peerDomain: string,
    forceReindex = false,
  ): Promise<Map<string, bigint>> {
    const [user] = await tx
      .select({
        account: tables.user.account,
        name: tables.user.name,
        avatar: tables.user.avatar,
        bio: tables.user.bio,
        profileRev: tables.user.profileRev,
      })
      .from(tables.user)
      .where(and(eq(tables.user.id, userId), eq(tables.user.domain, 'local')))
      .limit(1);
    if (!user) throw new Error(`local user ${userId} not found`);
    return this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain,
        account: user.account,
        domain: this.config.domain,
        eventType: 'PROFILE',
        subjectAccount: '',
        subjectDomain: 'local',
        forceReindex,
        body: {
          profileRev: user.profileRev,
          displayName: user.name,
          bio: user.bio,
          avatar: await this.readAvatar(user.avatar),
        },
      },
    ]);
  }

  async writeGroupProfileToPeerInTx(
    tx: DatabaseTransaction,
    groupId: number,
    peerDomain: string,
    forceReindex = false,
  ): Promise<Map<string, bigint>> {
    const group = await tx.query.group.findFirst({
      where: and(
        eq(tables.group.id, groupId),
        eq(tables.group.domain, 'local'),
      ),
      columns: {
        account: true,
        name: true,
        avatar: true,
        description: true,
        profileRev: true,
      },
    });
    if (!group) throw new Error(`local group ${groupId} not found`);
    return this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain,
        account: group.account,
        domain: this.config.domain,
        eventType: 'PROFILE',
        subjectAccount: '',
        subjectDomain: 'local',
        forceReindex,
        body: {
          profileRev: group.profileRev,
          displayName: group.name,
          bio: group.description,
          avatar: await this.readAvatar(group.avatar),
        },
      },
    ]);
  }

  async cleanupUserProfileProjectionInTx(
    tx: DatabaseTransaction,
    localUserId: number,
    localAccount: string,
    peerDomain: string,
  ): Promise<void> {
    const visible = await tx.execute<{ visible: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM "RelationshipPair" pair
        JOIN "User" local_user ON local_user.id = ${localUserId}
        WHERE pair.active = true
          AND pair.kind = 'P2P'
          AND ((pair."endpointAAccount" = local_user.account
                AND pair."endpointADomain" = local_user.domain
                AND pair."endpointBDomain" = ${peerDomain})
            OR (pair."endpointBAccount" = local_user.account
                AND pair."endpointBDomain" = local_user.domain
                AND pair."endpointADomain" = ${peerDomain}))
      ) AS visible
    `);
    if (visible.rows[0]?.visible) return;
    await this.stateFeed.deleteProjectionInTx(tx, {
      peerDomain,
      account: localAccount,
      domain: this.config.domain,
      eventType: 'PROFILE',
      subjectAccount: '',
      subjectDomain: 'local',
    });
  }

  async cleanupGroupProjectionInTx(
    tx: DatabaseTransaction,
    threadId: number,
    groupId: number,
    groupAccount: string,
    peerDomain: string,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const visible = await tx.execute<{ visible: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM "RelationshipPair" pair
        JOIN "Group" group_state ON group_state.id = ${groupId}
        WHERE pair.active = true
          AND pair.kind = 'GROUP_MEMBER'
          AND pair."endpointAAccount" = group_state.account
          AND pair."endpointADomain" = group_state.domain
          AND pair."endpointBDomain" = ${peerDomain}
      ) AS visible
    `);
    if (visible.rows[0]?.visible)
      return this.writeGroupStateInTx(tx, threadId, clientFeedUpdates);
    clientFeedUpdates.push(
      ...(await this.clientStateFeed.recordGroupStateInTx(tx, threadId)),
    );
    if (!this.groupMetaFeed) throw new Error('group meta feed is unavailable');
    await this.groupMetaFeed.deactivateTargetInTx(tx, peerDomain, groupId);
    await this.stateFeed.deleteProjectionInTx(tx, {
      peerDomain,
      account: groupAccount,
      domain: this.config.domain,
      eventType: 'PROFILE',
      subjectAccount: '',
      subjectDomain: 'local',
    });
    await this.stateFeed.deleteProjectionInTx(tx, {
      peerDomain,
      account: groupAccount,
      domain: this.config.domain,
      eventType: 'GROUP_META_FEED_HEAD',
      subjectAccount: '',
      subjectDomain: 'local',
    });
    return new Map();
  }

  async writeGroupStateInTx(
    tx: DatabaseTransaction,
    threadId: number,
    clientFeedUpdates?: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const [state] = await tx
      .select({
        groupId: tables.group.id,
        account: tables.group.account,
        name: tables.group.name,
        bio: tables.group.description,
        avatar: tables.group.avatar,
        profileRev: tables.group.profileRev,
        dissolvedAt: tables.group.dissolvedAt,
      })
      .from(tables.messageThread)
      .innerJoin(
        tables.group,
        eq(tables.group.id, tables.messageThread.groupId),
      )
      .where(
        and(
          eq(tables.messageThread.id, threadId),
          eq(tables.group.domain, 'local'),
        ),
      )
      .limit(1);
    if (!state) return new Map();
    const roster = await tx
      .select({
        account: tables.user.account,
        domain: tables.user.domain,
        role: tables.threadMember.role,
        name: tables.user.name,
        avatar: tables.user.avatar,
        profileRev: tables.user.profileRev,
        left: tables.threadMember.left,
      })
      .from(tables.threadMember)
      .innerJoin(tables.user, eq(tables.user.id, tables.threadMember.userId))
      .where(eq(tables.threadMember.threadId, threadId));
    const clientGroupUpdates = await this.clientStateFeed.recordGroupStateInTx(
      tx,
      threadId,
    );
    clientFeedUpdates?.push(...clientGroupUpdates);
    const activePeerRows = await tx
      .select({ domain: tables.relationshipPair.endpointBDomain })
      .from(tables.relationshipPair)
      .where(
        and(
          eq(tables.relationshipPair.threadId, threadId),
          eq(tables.relationshipPair.kind, 'GROUP_MEMBER'),
          eq(tables.relationshipPair.active, true),
          eq(tables.relationshipPair.endpointAType, 'GROUP'),
          eq(tables.relationshipPair.endpointBType, 'USER'),
          ne(tables.relationshipPair.endpointBDomain, 'local'),
        ),
      );
    const peerDomains = new Set(activePeerRows.map((row) => row.domain));
    if (!peerDomains.size) return new Map();
    const groupAvatar = await this.readAvatar(state.avatar);
    if (!this.groupMetaFeed) throw new Error('group meta feed is unavailable');
    const memberProjection = state.dissolvedAt
      ? []
      : await Promise.all(
          roster
            .filter((member) => !member.left)
            .map(async (member) => ({
              account: member.account,
              domain:
                member.domain === 'local' ? this.config.domain : member.domain,
              body: {
                role: member.role ?? GroupRole.MEMBER,
                profileRev: member.profileRev,
                displayName: member.name,
                avatar: await this.readAvatar(member.avatar),
              },
            })),
        );
    const groupMetaHeads = new Map<string, bigint>();
    for (const peerDomain of peerDomains)
      groupMetaHeads.set(
        peerDomain,
        await this.groupMetaFeed.reconcileInTx(
          tx,
          peerDomain,
          state.groupId,
          memberProjection,
        ),
      );
    const published = await this.stateFeed.writeManyInTx(
      tx,
      [...peerDomains].flatMap((peerDomain) => [
        {
          peerDomain,
          account: state.account,
          domain: this.config.domain,
          eventType: 'PROFILE' as const,
          subjectAccount: '',
          subjectDomain: 'local',
          revision: state.profileRev,
          body: {
            profileRev: state.profileRev,
            displayName: state.name,
            bio: state.bio,
            avatar: groupAvatar,
          },
        },
        {
          peerDomain,
          account: state.account,
          domain: this.config.domain,
          eventType: 'GROUP_META_FEED_HEAD' as const,
          subjectAccount: '',
          subjectDomain: 'local',
          body: {
            groupMetaFeedEndId: groupMetaHeads.get(peerDomain)!.toString(),
          },
        },
      ]),
    );
    // A newly authorized peer must receive the already-committed thread head in the same transaction.
    // Writing it after identity and roster state preserves the provider-side dependency order.
    for (const peerDomain of peerDomains)
      await this.threadContentHeads.refreshInTx(tx, peerDomain, threadId);
    return published;
  }

  private async readAvatar(path: string): Promise<{
    digest: string;
    mimeType: 'image/webp';
    base64: string;
    width: number;
    height: number;
  } | null> {
    if (!path) return null;
    const wire = await this.upload.readAvatarAsWire(path);
    if (!wire) return null;
    return {
      digest: createHash('sha256')
        .update(Buffer.from(wire.b64, 'base64'))
        .digest('hex'),
      mimeType: 'image/webp',
      base64: wire.b64,
      width: wire.w,
      height: wire.h,
    };
  }
}
