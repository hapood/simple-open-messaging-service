import { writeP2PClientRelationshipInTx } from './shared/p2p-client-relationship.js';
import {
  groupState as group,
  groupStateFields,
} from '../group/shared/group-state.js';
import { isGroupDissolvedInTx } from '../group/shared/group-state.js';
import { lockBusinessAccountsInTx } from '../common/locks/account-business-lock.js';
import { MeasureBusinessOperation } from '../diagnostics/execution-measurement.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../user/account-address.js';
import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  relationshipIntent,
  messageThread,
  accountThreadState,
  account as user,
} from '../database/schema.js';
import { normalizeAccount } from '../common/account.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { openFederatedAudienceInTx } from '../federation/federation-audience.js';
import { RelationshipIntentService } from './relationship-intent.service.js';
import { FederationNamespaceService } from '../federation/federation-namespace.service.js';

const RELATIONSHIP_SHELL_GC_INTERVAL_MS = 60 * 60 * 1000;

export type FriendRelationshipState =
  | 'NONE'
  | 'OUTGOING_PENDING'
  | 'INCOMING_PENDING'
  | 'FRIEND';

export interface FederatedPendingProfileSnapshot {
  displayName: string;
  avatar?: string;
}

export function applyFederatedPendingProfileSnapshot(
  profile: { name: string; avatar: string },
  snapshot?: FederatedPendingProfileSnapshot,
): { name: string; avatar: string } {
  if (!snapshot) return profile;
  return {
    name: snapshot.displayName.slice(0, 30),
    avatar: snapshot.avatar ?? '',
  };
}

/** Relationship queries, projection maintenance, and group-invitation
 * authoring backed by authoritative directed intents. P2P commands live in the
 * user-intent business family. */
@Injectable()
export class RelationshipService {
  constructor(
    private readonly database: DatabaseService,
    private readonly participantService: AccountThreadStateService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly namespaces: FederationNamespaceService,
  ) {}

  /** Reap never-activated request shells after every authored request has expired. The transaction
   * rechecks all directional facts under pair locks, so a concurrent accept cannot lose its thread. */
  @Interval(RELATIONSHIP_SHELL_GC_INTERVAL_MS)
  async cleanupExpiredRelationshipShells(): Promise<number> {
    return this.database.db.transaction(async (tx) => {
      const candidates = await tx.execute<{ threadId: number }>(sql`
        SELECT pair."threadId"
        FROM "RelationshipPair" pair
        JOIN "MessageThread" thread ON thread.id = pair."threadId"
        WHERE pair.active = false AND pair.established = false
          AND pair.kind = 'P2P'
          AND pair."threadId" IS NOT NULL
          AND thread.type = 'P2P'
          AND NOT EXISTS (
            SELECT 1 FROM "Message" message
            WHERE message."threadId" = pair."threadId"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "RelationshipIntent" request
            WHERE request."pairId" = pair.id
              AND (request.status = 'ACCEPTED'
                OR (request.status = 'REQUESTED' AND request."expiresAt" > CURRENT_TIMESTAMP))
          )
        FOR UPDATE OF pair, thread SKIP LOCKED
      `);
      const ids = candidates.rows.map((row) => row.threadId);
      if (ids.length > 0) {
        await tx
          .delete(accountThreadState)
          .where(inArray(accountThreadState.threadId, ids));
        await tx.delete(messageThread).where(inArray(messageThread.id, ids));
      }
      return ids.length;
    });
  }

  async writeGroupRequestClientStateInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberUserId: number,
    pendingFeedUpdates: Array<{ userId: number; feedId: number }>,
  ): Promise<void> {
    const [state] = await tx
      .select({
        groupId: messageThread.id,
        account: groupStateFields.account,
        domain: groupStateFields.domain,
        name: groupStateFields.name,
        avatar: groupStateFields.avatar,
        description: groupStateFields.description,
        profileRev: groupStateFields.profileRev,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.id))
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!state?.groupId || state.domain !== 'local') return;
    const request = await tx.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorSide, 'A'),
        sql`EXISTS (
            SELECT 1 FROM "RelationshipPair" pair
            JOIN "Account" identity ON identity.id = ${memberUserId}
            WHERE pair.id = ${relationshipIntent.pairId}
              AND pair."threadId" = ${threadId}
              AND pair."endpointBAccount" = identity.account
              AND pair."endpointBDomain" = identity.domain
              AND pair."endpointANamespaceId" = pair."endpointBNamespaceId"
              AND pair."endpointBNamespaceId" = identity."namespaceId"
          )`,
      ),
    });
    const member = await tx.query.account.findFirst({
      where: eq(user.id, memberUserId),
      columns: { account: true },
    });
    if (!request || !member) return;
    const feedId = await this.clientStateFeed.writeInTx(tx, {
      userId: memberUserId,
      account: state.account,
      domain: 'local',
      namespaceId: 0,
      eventType: 'RELATIONSHIP_INTENT',
      subjectAccount: member.account,
      subjectDomain: 'local',
      body: {
        status:
          request.status === 'ACCEPTED'
            ? 'ACCEPTED'
            : request.status === 'REQUESTED'
              ? 'REQUESTED'
              : 'REVOKED',
        note: request.note,
        requestedAt: request.requestedAt?.getTime() ?? null,
        expiresAt: request.expiresAt?.getTime() ?? null,
        threadId,
        group: {
          account: state.account,
          domain: 'local',
          isLocal: true,
          name: state.name,
          avatar: state.avatar,
          description: state.description,
          profileRev: state.profileRev,
        },
      },
    });
    if (feedId !== null)
      pendingFeedUpdates.push({ userId: memberUserId, feedId });
  }

  /** Relationship state for an exact federated Address without a local account row. */
  async federatedRelationshipStatus(
    localUserId: number,
    remoteAccount: string,
    remoteDomain: string,
  ): Promise<FriendRelationshipState> {
    const account = normalizeAccount(remoteAccount);
    const { relationship } = await this.database.db.transaction(async (tx) => {
      const context = await this.namespaces.captureActiveInTx(tx, remoteDomain);
      const relationship =
        await this.relationshipIntents.readP2PRelationshipByAddressInTx(
          tx,
          localUserId,
          {
            account,
            domain: remoteDomain,
            namespaceId: context.namespaceId,
          },
        );
      return { relationship };
    });
    if (relationship?.pair.active) return 'FRIEND';
    const now = new Date();
    if (
      relationship?.remoteIntent?.status === 'REQUESTED' &&
      relationship.remoteIntent.expiresAt !== null &&
      relationship.remoteIntent.expiresAt > now
    )
      return 'INCOMING_PENDING';
    if (
      relationship?.localIntent?.status === 'REQUESTED' &&
      relationship.localIntent.expiresAt !== null &&
      relationship.localIntent.expiresAt > now
    )
      return 'OUTGOING_PENDING';
    return 'NONE';
  }

  async writeRelationshipRequestClientStateInTx(
    tx: DatabaseTransaction,
    firstTarget: AccountTarget,
    secondTarget: AccountTarget,
  ): Promise<Array<{ userId: number; feedId: number }>> {
    return writeP2PClientRelationshipInTx(
      tx,
      firstTarget,
      secondTarget,
      this.relationshipIntents,
      this.clientStateFeed,
    );
  }

  /**
   * Authoritative relationship state for discovery UI. FRIEND takes precedence over stale pending
   * rows; only unexpired PENDING requests count. The result contains every requested id so clients do
   * not need to infer missing rows.
   */
  async friendRelationshipStatuses(
    me: number,
    requestedUserIds: number[],
  ): Promise<
    Array<{
      userId: number;
      status: FriendRelationshipState;
    }>
  > {
    const userIds = [...new Set(requestedUserIds)].filter((id) => id !== me);
    if (userIds.length === 0) return [];

    const [friendIds, requestRows] = await Promise.all([
      this.participantService.getActiveP2PPeerUserIds(me),
      this.database.db.execute<{
        peerUserId: number;
        direction: 'INCOMING' | 'OUTGOING';
      }>(sql`
        SELECT peer.id AS "peerUserId",
          CASE
            WHEN (intent."authorSide" = 'A'
              AND pair."endpointAAccount" = self.account
              AND pair."endpointADomain" = self.domain)
              OR (intent."authorSide" = 'B'
                AND pair."endpointBAccount" = self.account
                AND pair."endpointBDomain" = self.domain)
            THEN 'OUTGOING' ELSE 'INCOMING'
          END AS direction
        FROM "RelationshipIntent" intent
        JOIN "RelationshipPair" pair ON pair.id = intent."pairId"
        JOIN "Account" self ON self.id = ${me}
        JOIN "Account" peer ON peer.id IN (${sql.join(
          userIds.map((userId) => sql`${userId}`),
          sql`, `,
        )})
         AND ((peer.account = pair."endpointAAccount" AND peer.domain = pair."endpointADomain")
           OR (peer.account = pair."endpointBAccount" AND peer.domain = pair."endpointBDomain"))
        WHERE pair.kind = 'P2P'
          AND pair."endpointANamespaceId" = pair."endpointBNamespaceId"
          AND self."namespaceId" = 0
          AND pair."endpointANamespaceId" = peer."namespaceId"
          AND intent.status = 'REQUESTED'
          AND intent."expiresAt" > CURRENT_TIMESTAMP
          AND ((self.account = pair."endpointAAccount" AND self.domain = pair."endpointADomain")
            OR (self.account = pair."endpointBAccount" AND self.domain = pair."endpointBDomain"))
          AND peer.id <> self.id
      `),
    ]);
    const requests = requestRows.rows;
    const friends = new Set(friendIds);
    const outgoing = new Set(
      requests
        .filter((request) => request.direction === 'OUTGOING')
        .map((request) => request.peerUserId),
    );
    const incoming = new Set(
      requests
        .filter((request) => request.direction === 'INCOMING')
        .map((request) => request.peerUserId),
    );

    return userIds.map((userId) => {
      if (friends.has(userId)) return { userId, status: 'FRIEND' };
      if (outgoing.has(userId)) return { userId, status: 'OUTGOING_PENDING' };
      if (incoming.has(userId)) return { userId, status: 'INCOMING_PENDING' };
      return { userId, status: 'NONE' };
    });
  }

  /** Create or refresh one group membership invitation. */
  @MeasureBusinessOperation('relationship.create-group-invite')
  async createGroupInvite(
    fromUserId: number,
    threadId: number,
    toUserId: AccountTarget,
    note = '',
    afterWrite?: (tx: DatabaseTransaction) => Promise<void>,
  ): Promise<string | null> {
    const trimmed = (note ?? '').slice(0, 255);
    return this.database.db.transaction(async (tx) => {
      if (await isGroupDissolvedInTx(tx, threadId)) return null;
      const memberIdentity = await accountAddressInTx(tx, toUserId);
      const target = await tx.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: {
          id: true,
          type: true,
          groupAccount: true,
          groupDomain: true,
        },
      });
      if (target?.type !== 'GROUP')
        throw new Error('group invite target is invalid');
      // Entry-scope advisory: held before the row locks below; nested writers
      // never take advisories themselves.
      await lockBusinessAccountsInTx(tx, [
        { account: target.groupAccount!, domain: target.groupDomain! },
      ]);
      await this.relationshipIntents.lockGroupMutationInTx(tx, {
        groupId: target.id,
        memberUserId: toUserId,
        threadId,
        projectionUserIds: [fromUserId],
      });
      if (afterWrite) await afterWrite(tx);
      else
        await this.relationshipIntents.writeGroupAuthoredIntentInTx(tx, {
          groupId: target.id,
          memberUserId: toUserId,
          threadId,
          author: 'GROUP',
          status: 'REQUESTED',
          note: trimmed,
        });
      const request = await tx.query.relationshipIntent.findFirst({
        where: and(
          eq(relationshipIntent.authorSide, 'A'),
          sql`EXISTS (
            SELECT 1 FROM "RelationshipPair" pair
            WHERE pair.id = ${relationshipIntent.pairId}
              AND pair."threadId" = ${threadId}
              AND pair."endpointBAccount" = ${memberIdentity.account}
              AND pair."endpointBDomain" = ${memberIdentity.domain}
              AND pair."endpointANamespaceId" = pair."endpointBNamespaceId"
              AND pair."endpointBNamespaceId" = ${memberIdentity.namespaceId}
          )`,
        ),
        columns: {
          id: true,
        },
      });
      if (!request) throw new Error('group request write disappeared');
      if (memberIdentity.domain !== 'local')
        await openFederatedAudienceInTx(tx, memberIdentity.domain, threadId);
      return request.id.toString();
    });
  }
}
