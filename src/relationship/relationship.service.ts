import { writeP2PClientRelationshipInTx } from './shared/p2p-client-relationship.js';
import { type AccountTarget } from '../user/account-address.js';
import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { inArray, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  messageThread,
  accountThreadState,
} from '../database/schema.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
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
            SELECT 1
            FROM (VALUES
              (
                pair."endpointAAccount",
                pair."endpointANamespaceId",
                pair."endpointBAccount",
                pair."endpointBNamespaceId"
              ),
              (
                pair."endpointBAccount",
                pair."endpointBNamespaceId",
                pair."endpointAAccount",
                pair."endpointANamespaceId"
              )
            ) AS direction("authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId")
            JOIN "RelationshipIntent" request
              ON request."authorAccount" = direction."authorAccount"
              AND request."authorNamespaceId" = direction."authorNamespaceId"
              AND request."receiverAccount" = direction."receiverAccount"
              AND request."receiverNamespaceId" = direction."receiverNamespaceId"
            WHERE request.status = 'ACCEPTED'
              OR (request.status = 'REQUESTED' AND request."expiresAt" > CURRENT_TIMESTAMP)
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
}
