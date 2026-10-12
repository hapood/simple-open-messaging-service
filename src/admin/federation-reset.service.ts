import { HttpStatus, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { FederationNamespaceService } from '../federation/federation-namespace.service.js';
import { ProfileNamespaceFeedService } from '../federation/profile-namespace-feed.service.js';
import { SseService } from '../gateway/sse.service.js';

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
    private readonly profileNamespaceFeed: ProfileNamespaceFeedService,
    private readonly sse: SseService,
  ) {}

  async preview(domain: string): Promise<FederationResetPreview> {
    const normalized = this.requireDomain(domain);
    return this.database.db.transaction(async (tx) => {
      const peerResult = await tx.execute<{
        id: number;
        trustLevel: string;
        haltCode: number | null;
        haltReason: string | null;
      }>(sql`
        SELECT id, "trustLevel", "haltCode", "haltReason"
        FROM "IdentityNamespace"
        WHERE domain = ${normalized}
          AND active = true
        FOR NO KEY UPDATE
      `);
      const peer = peerResult.rows[0];
      this.assertResettable(peer, normalized);
      const namespaceId = peer.id;
      const result = await tx.execute<PreviewCounts>(sql`
        WITH remote_users AS (
          SELECT DISTINCT account, domain FROM "Profile" WHERE "publisherNamespaceId" = ${namespaceId} AND account NOT LIKE '!%'
        ), remote_group_meta_facts AS (
          SELECT member_fact."threadId"
          FROM "GroupMetaMemberFeed" member_fact
          JOIN "MessageThread" group_thread
            ON group_thread.id = member_fact."threadId"
          WHERE group_thread."authorityNamespaceId" = ${namespaceId}
            OR member_fact.body -> 'namespaceId' = to_jsonb(${normalized}::integer)
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
            WHERE "publisherNamespaceId" = ${namespaceId}) AS "authoredMessageCount",
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
        id: number;
        trustLevel: string;
        haltCode: number | null;
      }>(sql`
        SELECT id, "trustLevel", "haltCode"
        FROM "IdentityNamespace"
        WHERE domain = ${normalized}
          AND active = true
        FOR NO KEY UPDATE
      `);
      this.assertResettable(peerResult.rows[0], normalized);
      const archived = await this.namespaces.retireActiveInTx(tx, normalized);
      // Broadcast the retirement: a reset is a client-visible change to the
      // peer's own binding (the nsid-0 pair in this publisher's space), so
      // publish it on the shared feed and tell every device to re-resolve —
      // mirroring the admin re-bind / root-rotation paths. Devices that hold
      // the pre-reset domain then converge to the ARCHIVED status.
      await this.profileNamespaceFeed.recordNamespaceChangeInTx(
        tx,
        archived.namespaceId,
      );
      const clientChangeId =
        await this.profileNamespaceFeed.recordClientChangeInTx(tx, {
          publisherNamespaceId: archived.namespaceId,
          profileNamespaceId: 0,
        });
      return {
        domain: normalized,
        archivedNamespaceId: archived.namespaceId,
        activeNamespaceId: null,
        status: 'reset' as const,
        clientChangeId,
      };
    });
    this.sse.notifyProfileNamespaceChange(result.clientChangeId);
    return result;
  }

  private assertResettable(
    peer:
      | {
          id: number;
          trustLevel: string;
          haltCode: number | null;
        }
      | undefined,
    domain: string,
  ): asserts peer is {
    id: number;
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
      peer.haltCode !== BusinessCode.FEDERATION_IDENTITY_MISMATCH
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
