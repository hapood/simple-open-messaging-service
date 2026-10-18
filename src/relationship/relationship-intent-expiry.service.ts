import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  readGroupState,
  groupStateFields,
} from '../group/shared/group-state.js';
import { validateNamespacedAddress } from '../common/client-identity.js';
import { localAccountsForTargetsInTx } from '../user/account-address.js';
import { DatabaseService } from '../database/database.service.js';
import type { PendingClientStateFeedUpdate } from '../client-state-feed/client-state-feed.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { RelationshipService } from './relationship.service.js';
import { RelationshipIntentService } from './relationship-intent.service.js';
import { GroupRelationshipFoldService } from '../group/membership-intent/shared/group-relationship-fold.service.js';
import { GroupRelationshipMutationService } from '../group/membership-intent/shared/group-relationship-mutation.service.js';
import { PeerStateFeedService } from '../federation/peer-state-feed.service.js';
import { FederationStateFeedPushService } from '../federation/federation-state-feed-push.service.js';
import {
  lockBusinessAccountsInTx,
  type BusinessScopeAddress,
} from '../common/locks/account-business-lock.js';

/**
 * Materializes expired directions authored by this server as durable
 * revocations. The expiry boundary itself remains authoritative; this sweep
 * only makes the already-effective negative state explicit so clients and
 * peers converge without retaining stale REQUESTED snapshots.
 *
 * Locking order: business-scope account locks, then outbound state-feed
 * namespace locks, then the RelationshipPair row lock — matching the order the
 * intent-acceptance paths use, so concurrent intent writes and this sweep
 * serialize without deadlock.
 */
@Injectable()
export class RelationshipIntentExpiryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly relationships: RelationshipService,
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly groupRelationships: GroupRelationshipFoldService,
    private readonly relationshipMutations: GroupRelationshipMutationService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly stateFeedPush: FederationStateFeedPushService,
  ) {}

  /** Revoke every locally authored REQUESTED intent whose expiry has passed. Returns the count. */
  async revokeExpiredLocalRequests(): Promise<number> {
    const pendingClientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const result = await this.database.db.transaction(async (tx) => {
      const expired = await tx.execute<{
        pairId: string;
        kind: 'P2P' | 'GROUP_MEMBER';
        authorAccount: string;
        authorDomain: string;
        authorNamespaceId: number;
        subjectAccount: string;
        subjectDomain: string;
        subjectNamespaceId: number;
        threadId: number | null;
        profileNamespaceId: number;
        profileRev: number;
      }>(sql`
        SELECT pair.id::text AS "pairId", pair.kind, pair."threadId",
          intent."authorAccount", intent."authorNamespaceId",
          ans.domain AS "authorDomain",
          intent."receiverAccount" AS "subjectAccount",
          intent."receiverNamespaceId" AS "subjectNamespaceId",
          sns.domain AS "subjectDomain",
          intent."profileNamespaceId", intent."profileRev"
        FROM "RelationshipIntent" intent
        JOIN "RelationshipPair" pair
          ON (pair."endpointAAccount" = intent."authorAccount"
              AND pair."endpointANamespaceId" = intent."authorNamespaceId"
              AND pair."endpointBAccount" = intent."receiverAccount"
              AND pair."endpointBNamespaceId" = intent."receiverNamespaceId")
            OR (pair."endpointBAccount" = intent."authorAccount"
              AND pair."endpointBNamespaceId" = intent."authorNamespaceId"
              AND pair."endpointAAccount" = intent."receiverAccount"
              AND pair."endpointANamespaceId" = intent."receiverNamespaceId")
        JOIN "IdentityNamespace" ans ON ans.id = intent."authorNamespaceId"
        JOIN "IdentityNamespace" sns ON sns.id = intent."receiverNamespaceId"
        WHERE intent."authorNamespaceId" = 0
          AND intent.status = 'REQUESTED'
          AND intent."expiresAt" <= CURRENT_TIMESTAMP
        ORDER BY intent."expiresAt", intent."authorAccount", intent."authorNamespaceId",
          intent."receiverAccount", intent."receiverNamespaceId"
      `);
      const businessAddresses: BusinessScopeAddress[] = [];
      for (const request of expired.rows) {
        if (request.kind === 'P2P') {
          businessAddresses.push(
            {
              account: request.authorAccount,
              profileNamespaceId: request.authorNamespaceId,
            },
            {
              account: request.subjectAccount,
              profileNamespaceId: request.subjectNamespaceId,
            },
          );
        } else {
          const groupIsAuthor = request.authorAccount.startsWith('!');
          businessAddresses.push(
            groupIsAuthor
              ? {
                  account: request.authorAccount,
                  profileNamespaceId: request.authorNamespaceId,
                }
              : {
                  account: request.subjectAccount,
                  profileNamespaceId: request.subjectNamespaceId,
                },
          );
        }
      }
      await lockBusinessAccountsInTx(tx, businessAddresses);
      await this.stateFeed.lockOutboundStateFeedNamespacesInTx(
        tx,
        expired.rows
          .filter((request) => request.subjectNamespaceId !== 0)
          .map((request) => ({
            peerDomain: request.subjectDomain,
            namespaceId: request.subjectNamespaceId,
          })),
      );
      const allocated = new Map<number, bigint>();
      const namespaceIds = new Set<number>();
      let count = 0;
      for (const request of expired.rows) {
        const pairId = BigInt(request.pairId);
        await tx.execute(sql`
          SELECT id FROM "RelationshipPair" WHERE id = ${pairId}
          FOR NO KEY UPDATE
        `);
        const updated = await tx.execute(sql`
          UPDATE "RelationshipIntent"
          SET status = 'REVOKED', note = '', "requestedAt" = NULL,
            "expiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "authorAccount" = ${request.authorAccount}
            AND "authorNamespaceId" = ${request.authorNamespaceId}
            AND "receiverAccount" = ${request.subjectAccount}
            AND "receiverNamespaceId" = ${request.subjectNamespaceId}
            AND status = 'REQUESTED' AND "expiresAt" <= CURRENT_TIMESTAMP
          RETURNING 1
        `);
        if ((updated.rowCount ?? 0) === 0) continue;
        count += 1;
        if (request.kind === 'GROUP_MEMBER' && request.threadId !== null) {
          const groupIsAuthor = request.authorAccount.startsWith('!');
          const groupState = await readGroupState(
            tx,
            and(
              eq(
                groupStateFields.account,
                groupIsAuthor ? request.authorAccount : request.subjectAccount,
              ),
              eq(
                groupStateFields.namespaceId,
                groupIsAuthor
                  ? request.authorNamespaceId
                  : request.subjectNamespaceId,
              ),
            ),
          );
          const member = validateNamespacedAddress({
            account: groupIsAuthor
              ? request.subjectAccount
              : request.authorAccount,
            domain: groupIsAuthor
              ? request.subjectDomain
              : request.authorDomain,
            namespaceId: groupIsAuthor
              ? request.subjectNamespaceId
              : request.authorNamespaceId,
          });
          if (!groupState)
            throw new Error('expired group relationship endpoint missing');
          await this.groupRelationships.syncActiveInTx(tx, {
            threadId: request.threadId,
            groupId: groupState.id,
            memberUserId: member,
            active: false,
            hostedLocally: groupState.namespaceId === 0,
          });
          if (groupState.namespaceId === 0)
            await this.relationshipMutations.writeGroupRequestEffectsInTx(
              tx,
              request.threadId,
              member,
              'EXPIRED',
              groupIsAuthor ? 'INVITATION' : 'APPLICATION',
              false,
            );
          const [localMember] = await localAccountsForTargetsInTx(tx, [member]);
          if (localMember)
            await this.relationships.writeGroupRequestClientStateInTx(
              tx,
              request.threadId,
              localMember.id,
              pendingClientFeedUpdates,
            );
        } else if (request.kind === 'P2P') {
          const author = validateNamespacedAddress({
            account: request.authorAccount,
            domain: request.authorDomain,
            namespaceId: request.authorNamespaceId,
          });
          const subject = validateNamespacedAddress({
            account: request.subjectAccount,
            domain: request.subjectDomain,
            namespaceId: request.subjectNamespaceId,
          });
          await this.relationshipIntents.setPairActiveInTx(
            tx,
            author,
            subject,
            false,
          );
          pendingClientFeedUpdates.push(
            ...(await this.relationships.writeRelationshipRequestClientStateInTx(
              tx,
              author,
              subject,
            )),
          );
        }
        if (request.subjectNamespaceId === 0) continue;
        namespaceIds.add(request.subjectNamespaceId!);
        const revisions = await this.stateFeed.writeManyInTx(tx, [
          {
            namespaceId: request.subjectNamespaceId!,
            account: request.authorAccount,
            subjectAccount: request.subjectAccount,
            subjectNamespaceId: request.subjectNamespaceId,
            eventType: 'RELATIONSHIP_INTENT',
            body: {
              status: 'REVOKED',
              namespaceId: request.profileNamespaceId,
              profileRev: request.profileRev,
              note: '',
              requestedAt: null,
              expiresAt: null,
            },
          },
        ]);
        for (const [namespaceId, revision] of revisions)
          allocated.set(namespaceId, revision);
      }
      return { count, allocated, namespaceIds };
    });
    this.clientStateFeed.notifyFeedUpdates(pendingClientFeedUpdates);
    this.stateFeedPush.pushStateFeedNamespaces(result.namespaceIds);
    return result.count;
  }
}
