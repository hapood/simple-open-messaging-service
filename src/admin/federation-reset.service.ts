import { HttpStatus, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { FederationNamespaceService } from '../federation/federation-namespace.service.js';

export interface FederationResetPreview {
  domain: string;
  activeNamespaceId: number;
  haltReason: string | null;
  foreignUserCount: number;
  groupMetaMemberFactCount: number;
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
        FOR NO KEY UPDATE
      `);
      const peer = peerResult.rows[0];
      this.assertResettable(peer, normalized);
      const namespaceId = peer.activeNamespaceId;
      const result = await tx.execute<PreviewCounts>(sql`
        WITH remote_users AS (
          SELECT DISTINCT account, domain FROM "Profile" WHERE "namespaceId" = ${namespaceId} AND account NOT LIKE '!%'
        ), remote_group_meta_facts AS (
          SELECT member_fact."threadId"
          FROM "GroupMetaMemberFeed" member_fact
          JOIN "MessageThread" group_thread
            ON group_thread.id = member_fact."threadId"
          WHERE group_thread."authorityNamespaceId" = ${namespaceId}
            OR member_fact."memberDomain" = ${normalized}
        ), affected_threads AS (
          SELECT pair."threadId"
          FROM "RelationshipPair" pair
          WHERE pair."threadId" IS NOT NULL
            AND (pair."endpointANamespaceId" = ${namespaceId}
              OR pair."endpointBNamespaceId" = ${namespaceId})
          UNION
          SELECT thread.id
          FROM remote_group_meta_facts member_fact
          JOIN "MessageThread" thread ON thread.id = member_fact."threadId"
        )
        SELECT
          (SELECT count(*)::int FROM remote_users) AS "foreignUserCount",
          (SELECT count(*)::int FROM remote_group_meta_facts) AS "groupMetaMemberFactCount",
          (SELECT count(*)::int FROM affected_threads) AS "affectedThreadCount",
          (SELECT count(*)::int FROM "Message"
            WHERE "sourceNamespaceId" = ${namespaceId}) AS "authoredMessageCount",
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

    const result = await this.database.db.transaction(async (tx) => {
      const peerResult = await tx.execute<{
        activeNamespaceId: number | null;
        trustLevel: string;
        haltCode: number | null;
      }>(sql`
        SELECT "activeNamespaceId", "trustLevel", "haltCode"
        FROM "FederatedPeer"
        WHERE domain = ${normalized}
        FOR NO KEY UPDATE
      `);
      this.assertResettable(peerResult.rows[0], normalized);
      const archived = await this.namespaces.retireActiveInTx(tx, normalized);

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
            "peerAcceptanceConfirmed" = false,
            "localServiceAvailable" = false,
            "remoteServiceReachable" = false,
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
