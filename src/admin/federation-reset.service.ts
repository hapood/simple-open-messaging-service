import { HttpStatus, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { FederationNamespaceService } from '../federation/federation-namespace.service.js';

export interface FederationResetPreview {
  domain: string;
  activeNamespaceId: number;
  haltReason: string | null;
  foreignUserCount: number;
  participantCount: number;
  affectedThreadCount: number;
  authoredMessageCount: number;
  relationshipCount: number;
  warning: string;
}

export interface FederationResetResult {
  domain: string;
  archivedNamespaceId: number;
  activeNamespaceId: null;
  status: 'reset';
}

type PreviewCounts = Omit<
  FederationResetPreview,
  'domain' | 'activeNamespaceId' | 'haltReason' | 'warning'
>;

const normalizeDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/\.+$/, '');

/** Retires one verified peer identity without deleting any identity-derived history. */
@Injectable()
export class FederationResetService {
  constructor(
    private readonly database: DatabaseService,
    private readonly namespaces: FederationNamespaceService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  async preview(domain: string): Promise<FederationResetPreview> {
    const normalized = this.requireDomain(domain);
    return this.database.db.transaction(async (tx) => {
      const peerResult = await tx.execute<{
        activeNamespaceId: number | null;
        trustLevel: string;
        haltCode: number | null;
        haltReason: string | null;
      }>(sql`
        SELECT "activeNamespaceId", "trustLevel", "haltCode", "haltReason"
        FROM "FederatedPeer"
        WHERE domain = ${normalized}
        FOR UPDATE
      `);
      const peer = peerResult.rows[0];
      this.assertResettable(peer, normalized);
      const namespaceId = peer.activeNamespaceId;
      const result = await tx.execute<PreviewCounts>(sql`
        WITH remote_users AS (
          SELECT id FROM "User" WHERE "namespaceId" = ${namespaceId}
        ), affected_threads AS (
          SELECT DISTINCT member."threadId"
          FROM "ThreadMember" member
          JOIN remote_users remote_user ON remote_user.id = member."userId"
        )
        SELECT
          (SELECT count(*)::int FROM remote_users) AS "foreignUserCount",
          (SELECT count(*)::int FROM "ThreadMember" member
            JOIN remote_users remote_user ON remote_user.id = member."userId") AS "participantCount",
          (SELECT count(*)::int FROM affected_threads) AS "affectedThreadCount",
          (SELECT count(*)::int FROM "Message"
            WHERE "creatorNamespaceId" = ${namespaceId}
               OR "sourceNamespaceId" = ${namespaceId}) AS "authoredMessageCount",
          (SELECT count(*)::int FROM "RelationshipPair"
            WHERE "endpointANamespaceId" = ${namespaceId}
               OR "endpointBNamespaceId" = ${namespaceId}) AS "relationshipCount"
      `);
      const counts = result.rows[0];
      if (!counts) throw new Error('federation reset preview returned no row');
      return {
        domain: normalized,
        activeNamespaceId: namespaceId,
        haltReason: peer.haltReason,
        ...counts,
        warning:
          'Reset retires the active namespace. Historical users, threads, relationships, and messages are retained.',
      };
    });
  }

  async start(
    domain: string,
    confirmDomain: string,
  ): Promise<FederationResetResult> {
    const normalized = this.requireDomain(domain);
    if (this.requireDomain(confirmDomain) !== normalized) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'confirmation domain does not match',
        HttpStatus.BAD_REQUEST,
      );
    }

    const pending: Array<{ userId: number; feedId: number }> = [];
    const result = await this.database.db.transaction(async (tx) => {
      const peerResult = await tx.execute<{
        activeNamespaceId: number | null;
        trustLevel: string;
        haltCode: number | null;
      }>(sql`
        SELECT "activeNamespaceId", "trustLevel", "haltCode"
        FROM "FederatedPeer"
        WHERE domain = ${normalized}
        FOR UPDATE
      `);
      this.assertResettable(peerResult.rows[0], normalized);
      const archived = await this.namespaces.retireActiveInTx(tx, normalized);

      const affected = await tx.execute<{ userId: number }>(sql`
        SELECT DISTINCT participant."accountId" AS "userId"
        FROM "ThreadParticipant" participant
        JOIN "ThreadMember" member ON member."threadId" = participant."threadId"
        JOIN "User" remote_user ON remote_user.id = member."userId"
        WHERE remote_user."namespaceId" = ${archived.namespaceId}
        UNION
        SELECT DISTINCT feed."userId"
        FROM "ClientStateFeed" feed
        WHERE feed."namespaceId" = ${archived.namespaceId}
      `);

      for (const { userId } of affected.rows) {
        const feedId = await this.clientStateFeed.writeInTx(tx, {
          userId,
          account: '',
          domain: normalized,
          eventType: 'NAMESPACE_CHANGED',
          subjectAccount: '',
          subjectDomain: 'local',
          namespaceId: archived.namespaceId,
          body: {
            domain: normalized,
            previousNamespaceId: archived.namespaceId,
            activeNamespaceId: null,
          },
        });
        if (feedId !== null) pending.push({ userId, feedId });
      }

      await tx.execute(sql`
        UPDATE "FederatedPeer"
        SET "trustLevel" = 'unrecognized',
            "trustedAt" = NULL,
            "lastSuccessAt" = NULL,
            "degradedAt" = NULL,
            "degradationReason" = NULL,
            "haltedAt" = NULL,
            "haltCode" = NULL,
            "haltReason" = NULL,
            "recognizesPeer" = false,
            "outboundRecognitionConfirmed" = false,
            "inboundRecognitionConfirmed" = false,
            "lightweightInboundReady" = false,
            "localServiceAvailable" = false,
            "remoteServiceReachable" = false,
            "reverseRecognitionPending" = false,
            "outboundRecognizedAt" = NULL,
            "inboundRecognizedAt" = NULL,
            "resetAt" = CURRENT_TIMESTAMP
        WHERE domain = ${normalized}
      `);
      await tx.execute(sql`
        INSERT INTO "FederatedPeerEvent" (domain, type, reason)
        VALUES (${normalized}, 'reset', ${`retired namespace ${archived.namespaceId}`})
      `);
      return {
        domain: normalized,
        archivedNamespaceId: archived.namespaceId,
        activeNamespaceId: null,
        status: 'reset' as const,
      };
    });
    this.clientStateFeed.notifyFeedUpdates(pending);
    return result;
  }

  private assertResettable(
    peer:
      | {
          activeNamespaceId: number | null;
          trustLevel: string;
          haltCode: number | null;
        }
      | undefined,
    domain: string,
  ): asserts peer is {
    activeNamespaceId: number;
    trustLevel: string;
    haltCode: number;
  } {
    if (!peer) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'peer not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (
      peer.trustLevel !== 'halted' ||
      peer.haltCode !== BusinessCode.FEDERATION_IDENTITY_MISMATCH ||
      peer.activeNamespaceId === null
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `only an identity-mismatch halted peer with an active namespace can be reset: ${domain}`,
        HttpStatus.CONFLICT,
      );
    }
  }

  private requireDomain(value: string): string {
    const normalized = normalizeDomain(value);
    if (!normalized || normalized.length > 63) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid federation domain',
        HttpStatus.BAD_REQUEST,
      );
    }
    return normalized;
  }
}
