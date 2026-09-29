import { HttpStatus, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';

export interface AdminFederationNamespaceView extends Record<string, unknown> {
  id: number;
  domain: string;
  rootKeyFingerprint: string | null;
  rootPublicKey: string | null;
  peerAssignedLocalNamespaceId: number | null;
  identityPinnedAt: Date | null;
  createdAt: Date;
  retiredAt: Date | null;
  active: boolean;
}

export interface AdminFederationNamespaceSwitchResult {
  domain: string;
  activeNamespaceId: number;
  status: 'active_namespace_switched';
}

const normalizeDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/\.+$/, '');

/** Admin surface for inspecting and selecting a peer's active identity namespace. */
@Injectable()
export class FederationNamespaceAdminService {
  constructor(private readonly database: DatabaseService) {}

  async list(domain: string): Promise<AdminFederationNamespaceView[]> {
    const normalized = this.requireDomain(domain);
    const result = await this.database.db.execute<AdminFederationNamespaceView>(sql`
      SELECT
        ns.id,
        ns.domain,
        ns."rootKeyFingerprint",
        ns."rootPublicKey",
        ns."peerAssignedLocalNamespaceId",
        ns."identityPinnedAt",
        ns."createdAt",
        ns."retiredAt",
        peer."activeNamespaceId" = ns.id AS active
      FROM "IdentityNamespace" ns
      JOIN "FederatedPeer" peer ON peer.domain = ns.domain
      WHERE ns.domain = ${normalized}
        AND ns.id > 0
      ORDER BY active DESC, ns."retiredAt" IS NULL DESC, ns.id DESC
    `);
    return result.rows;
  }

  async setActive(
    domain: string,
    namespaceId: number,
  ): Promise<AdminFederationNamespaceSwitchResult> {
    const normalized = this.requireDomain(domain);
    if (!Number.isSafeInteger(namespaceId) || namespaceId <= 0) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'namespaceId must be a positive integer',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.database.db.transaction(async (tx) => {
      const peerResult = await tx.execute<{
        activeNamespaceId: number | null;
      }>(sql`
        SELECT "activeNamespaceId"
        FROM "FederatedPeer"
        WHERE domain = ${normalized}
        FOR NO KEY UPDATE
      `);
      const peer = peerResult.rows[0];
      if (!peer) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'peer not found',
          HttpStatus.NOT_FOUND,
        );
      }

      const namespaceResult = await tx.execute<{
        id: number;
        rootKeyFingerprint: string | null;
        rootPublicKey: string | null;
        identityPinnedAt: Date | null;
        retiredAt: Date | null;
      }>(sql`
        SELECT id, "rootKeyFingerprint", "rootPublicKey", "identityPinnedAt", "retiredAt"
        FROM "IdentityNamespace"
        WHERE id = ${namespaceId}
          AND domain = ${normalized}
          AND id > 0
        FOR NO KEY UPDATE
      `);
      const namespace = namespaceResult.rows[0];
      if (!namespace) {
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'namespace not found for peer',
          HttpStatus.NOT_FOUND,
        );
      }
      if (namespace.retiredAt) {
        throw new BusinessException(
          BusinessCode.FEDERATION_NAMESPACE_INACTIVE,
          'retired namespace cannot be made active',
          HttpStatus.CONFLICT,
        );
      }
      if (
        !namespace.rootKeyFingerprint ||
        !namespace.rootPublicKey ||
        !namespace.identityPinnedAt
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          'namespace has incomplete pinned identity evidence',
          HttpStatus.CONFLICT,
        );
      }
      if (peer.activeNamespaceId === namespaceId) {
        return {
          domain: normalized,
          activeNamespaceId: namespaceId,
          status: 'active_namespace_switched' as const,
        };
      }

      await tx.execute(sql`
        UPDATE "FederatedPeer"
        SET "activeNamespaceId" = ${namespaceId},
            "trustLevel" = 'establishing',
            "recognizesPeer" = true,
            "localServiceAvailable" = true,
            "peerAcceptanceConfirmed" = false,
            "remoteServiceReachable" = false,
            "lastSuccessAt" = NULL,
            "degradedAt" = NULL,
            "degradationReason" = NULL,
            "haltedAt" = NULL,
            "haltCode" = NULL,
            "haltReason" = NULL
        WHERE domain = ${normalized}
      `);
      await tx.execute(sql`
        INSERT INTO "PeerStateFeedPullCursor" ("peerDomain", "namespaceId")
        VALUES (${normalized}, ${namespaceId})
        ON CONFLICT DO NOTHING
      `);
      await tx.execute(sql`
        INSERT INTO "FederatedPeerEvent" (domain, type, reason)
        VALUES (${normalized}, 'namespace_active', ${`active namespace switched to ${namespaceId}`})
      `);
      return {
        domain: normalized,
        activeNamespaceId: namespaceId,
        status: 'active_namespace_switched' as const,
      };
    });
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
