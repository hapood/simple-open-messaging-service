import { Injectable, Optional } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { PendingClientStateFeedUpdate } from '../client-state-feed/client-state-feed.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import * as tables from '../database/schema.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationThreadContentHeadService } from './federation-thread-content-head.service.js';
import { GroupMetaFeedService } from './group-meta-feed.service.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';

@Injectable()
export class FederationProfileStatePublisher {
  private readonly config = loadFederationConfig();

  constructor(
    private readonly stateFeed: PeerStateFeedService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly threadContentHeads: FederationThreadContentHeadService,
    @Optional() private readonly groupMetaFeed?: GroupMetaFeedService,
  ) {}

  async cleanupGroupProjectionInTx(
    tx: DatabaseTransaction,
    threadId: number,
    groupId: number,
    groupAccount: string,
    peerDomain: string,
    namespaceId: number,
    clientFeedUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Map<string, bigint>> {
    const visible = await tx.execute<{ visible: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM "RelationshipPair" pair
        JOIN "Group" group_state ON group_state.id = ${groupId}
        WHERE pair.active = true
          AND pair.kind = 'GROUP_MEMBER'
          AND pair."endpointANamespaceId" = ${namespaceId}
          AND pair."endpointBNamespaceId" = ${namespaceId}
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
    await this.groupMetaFeed.deactivateTargetInTx(
      tx,
      peerDomain,
      namespaceId,
      groupId,
    );
    await this.stateFeed.deleteProjectionInTx(tx, {
      peerDomain,
      namespaceId,
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
        profileRev: tables.group.defaultProfileRev,
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
        namespaceId: tables.user.namespaceId,
        role: tables.threadMember.role,
        name: tables.user.name,
        avatar: tables.user.avatar,
        profileRev: sql<number>`CASE
          WHEN ${tables.threadMember.profileMessageSeq} IS NULL
          THEN ${tables.user.defaultProfileRev}
          ELSE ${tables.threadMember.profileRev}
        END`,
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
      .select({
        domain: tables.relationshipPair.endpointBDomain,
        namespaceId: tables.relationshipPair.endpointBNamespaceId,
      })
      .from(tables.relationshipPair)
      .innerJoin(
        tables.federatedPeer,
        and(
          eq(
            tables.federatedPeer.domain,
            tables.relationshipPair.endpointBDomain,
          ),
          eq(
            tables.federatedPeer.activeNamespaceId,
            tables.relationshipPair.endpointBNamespaceId,
          ),
        ),
      )
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
    const peerContexts = new Map(
      activePeerRows.flatMap((row) =>
        row.namespaceId === null
          ? []
          : [[row.domain, row.namespaceId] as const],
      ),
    );
    if (!peerContexts.size) return new Map();
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
              namespaceId: member.namespaceId,
              body: { role: member.role ?? GroupRole.MEMBER },
            })),
        );
    const groupMetaHeads = new Map<string, bigint>();
    for (const [peerDomain, namespaceId] of peerContexts)
      groupMetaHeads.set(
        peerDomain,
        await this.groupMetaFeed.reconcileInTx(
          tx,
          peerDomain,
          namespaceId,
          state.groupId,
          state.profileRev,
          memberProjection,
        ),
      );
    const published = await this.stateFeed.writeManyInTx(
      tx,
      [...peerContexts].map(([peerDomain, namespaceId]) => ({
        peerDomain,
        namespaceId,
        account: state.account,
        domain: this.config.domain,
        eventType: 'GROUP_META_FEED_HEAD' as const,
        subjectAccount: '',
        subjectDomain: 'local',
        body: {
          groupMetaFeedEndId: groupMetaHeads.get(peerDomain)!.toString(),
        },
      })),
    );
    // A newly authorized peer must receive the already-committed thread head in the same transaction.
    // Writing it after identity and roster state preserves the provider-side dependency order.
    for (const [peerDomain, namespaceId] of peerContexts)
      await this.threadContentHeads.refreshInTx(
        tx,
        peerDomain,
        namespaceId,
        threadId,
      );
    return published;
  }
}
