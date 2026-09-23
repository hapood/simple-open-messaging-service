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
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { openFederatedAudienceInTx } from '../federation/federation-audience.js';
import { RelationshipIntentService } from './relationship-intent.service.js';

const RELATIONSHIP_SHELL_GC_INTERVAL_MS = 60 * 60 * 1000;

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
    name: [...snapshot.displayName].slice(0, 31).join(''),
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
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly relationshipIntents: RelationshipIntentService,
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
