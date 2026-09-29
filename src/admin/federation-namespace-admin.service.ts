import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { FederationRecognitionService } from '../federation/federation-recognition.service.js';

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
  candidate: boolean;
  candidateStatus: 'pending' | 'failed' | null;
  failedCode: number | null;
  failedMessage: string | null;
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
  constructor(
    private readonly database: DatabaseService,
    @Optional() private readonly recognition?: FederationRecognitionService,
  ) {}

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
        ns.active,
        false AS candidate,
        NULL::varchar AS "candidateStatus",
        NULL::integer AS "failedCode",
        NULL::text AS "failedMessage"
      FROM "IdentityNamespace" ns
      WHERE ns.domain = ${normalized}
        AND ns.id > 0
      UNION ALL
      SELECT
        COALESCE(ns.id, 0) AS id,
        cand."nextDomain" AS domain,
        cand."rootKeyFingerprint",
        cand."rootPublicKey",
        cand."peerAssignedLocalNamespaceId",
        cand."verifiedAt" AS "identityPinnedAt",
        cand."createdAt",
        NULL::timestamp with time zone AS "retiredAt",
        false AS active,
        true AS candidate,
        cand.status AS "candidateStatus",
        cand."failedCode",
        cand."failedMessage"
      FROM "FederationNamespaceCandidate" cand
      LEFT JOIN "IdentityNamespace" ns ON ns.id = cand."matchedNamespaceId"
      WHERE cand."nextDomain" = ${normalized}
      ORDER BY active DESC, candidate DESC, "retiredAt" IS NULL DESC, id DESC
    `);
    return result.rows;
  }

  async setActive(
    domain: string,
    namespaceId?: number,
  ): Promise<AdminFederationNamespaceSwitchResult> {
    const normalized = this.requireDomain(domain);
    if (
      namespaceId !== undefined &&
      (!Number.isSafeInteger(namespaceId) || namespaceId <= 0)
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'namespaceId must be a positive integer',
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.database.db.transaction(async (tx) => {
      const candidateResult = await tx.execute<{
        nextDomain: string;
        matchedNamespaceId: number | null;
        rootKeyFingerprint: string;
        rootPublicKey: string;
        peerAssignedLocalNamespaceId: number | null;
        status: 'pending' | 'failed';
        failedCode: number | null;
        failedMessage: string | null;
        verifiedAt: Date;
      }>(sql`
        SELECT "nextDomain", "matchedNamespaceId", "rootKeyFingerprint", "rootPublicKey",
               "peerAssignedLocalNamespaceId", status, "failedCode", "failedMessage", "verifiedAt"
        FROM "FederationNamespaceCandidate"
        WHERE "nextDomain" = ${normalized}
        FOR UPDATE
      `);
      const candidate = candidateResult.rows[0];
      if (candidate) {
        const activeNamespaceId = await this.applyCandidateInTx(
          tx,
          normalized,
          candidate,
          namespaceId,
        );
        return {
          domain: normalized,
          activeNamespaceId,
          status: 'active_namespace_switched' as const,
        };
      }

      if (namespaceId === undefined) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'namespaceId is required when no verified candidate exists',
          HttpStatus.BAD_REQUEST,
        );
      }

      const namespaceResult = await tx.execute<{
        id: number;
        rootKeyFingerprint: string | null;
        rootPublicKey: string | null;
        identityPinnedAt: Date | null;
        retiredAt: Date | null;
        active: boolean;
      }>(sql`
        SELECT id, "rootKeyFingerprint", "rootPublicKey", "identityPinnedAt", "retiredAt", active
        FROM "IdentityNamespace"
        WHERE id = ${namespaceId}
          AND id > 0
          AND domain = ${normalized}
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
      if (!namespace.active) await this.activateNamespaceInTx(tx, normalized, namespaceId);
      return {
        domain: normalized,
        activeNamespaceId: namespaceId,
        status: 'active_namespace_switched' as const,
      };
    });
    void this.recognition?.recognize(normalized).catch(() => undefined);
    return result;
  }

  private async applyCandidateInTx(
    tx: DatabaseTransaction,
    normalized: string,
    candidate: {
      matchedNamespaceId: number | null;
      rootKeyFingerprint: string;
      rootPublicKey: string;
      peerAssignedLocalNamespaceId: number | null;
      status: 'pending' | 'failed';
      failedCode: number | null;
      failedMessage: string | null;
      verifiedAt: Date;
    },
    requestedNamespaceId?: number,
  ): Promise<number> {
    if (candidate.status === 'failed') {
      throw new BusinessException(
        candidate.failedCode ?? BusinessCode.FEDERATION_DOMAIN_CHANGE_REJECTED,
        candidate.failedMessage ?? 'verified candidate is failed',
        HttpStatus.CONFLICT,
      );
    }

    if (
      candidate.matchedNamespaceId !== null &&
      requestedNamespaceId !== undefined &&
      requestedNamespaceId !== candidate.matchedNamespaceId
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'namespaceId does not match verified candidate',
        HttpStatus.BAD_REQUEST,
      );
    }

    let activeNamespaceId = candidate.matchedNamespaceId;
    if (activeNamespaceId !== null) {
      const namespaceResult = await tx.execute<{
        id: number;
        rootKeyFingerprint: string | null;
        rootPublicKey: string | null;
        peerAssignedLocalNamespaceId: number | null;
        retiredAt: Date | null;
      }>(sql`
        SELECT id, "rootKeyFingerprint", "rootPublicKey", "peerAssignedLocalNamespaceId", "retiredAt"
        FROM "IdentityNamespace"
        WHERE id = ${activeNamespaceId}
          AND id > 0
        FOR NO KEY UPDATE
      `);
      const namespace = namespaceResult.rows[0];
      if (
        !namespace ||
        namespace.retiredAt ||
        namespace.rootKeyFingerprint !== candidate.rootKeyFingerprint ||
        namespace.rootPublicKey !== candidate.rootPublicKey
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          'candidate no longer matches pinned namespace evidence',
          HttpStatus.CONFLICT,
        );
      }
      if (
        namespace.peerAssignedLocalNamespaceId !== null &&
        candidate.peerAssignedLocalNamespaceId !== null &&
        namespace.peerAssignedLocalNamespaceId !==
          candidate.peerAssignedLocalNamespaceId
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          'candidate peer-assigned local namespace conflicts with pinned namespace',
          HttpStatus.CONFLICT,
        );
      }
      if (
        namespace.peerAssignedLocalNamespaceId === null &&
        candidate.peerAssignedLocalNamespaceId !== null
      ) {
        await tx.execute(sql`
          UPDATE "IdentityNamespace"
          SET "peerAssignedLocalNamespaceId" = ${candidate.peerAssignedLocalNamespaceId}
          WHERE id = ${activeNamespaceId}
        `);
      }
    } else {
      if (requestedNamespaceId !== undefined) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'namespaceId must be omitted for a new verified candidate',
          HttpStatus.BAD_REQUEST,
        );
      }
      const created = await tx.execute<{ id: number }>(sql`
        INSERT INTO "IdentityNamespace"
          (domain, "rootKeyFingerprint", "rootPublicKey", "identityPinnedAt", "peerAssignedLocalNamespaceId")
        VALUES (
          ${normalized},
          ${candidate.rootKeyFingerprint},
          ${candidate.rootPublicKey},
          ${candidate.verifiedAt},
          ${candidate.peerAssignedLocalNamespaceId}
        )
        RETURNING id
      `);
      activeNamespaceId = created.rows[0]?.id;
      if (!activeNamespaceId) throw new Error('failed to create namespace');
    }

    await this.activateNamespaceInTx(tx, normalized, activeNamespaceId);
    await tx.execute(sql`
      INSERT INTO "PeerStateFeedPullCursor" ("peerDomain", "namespaceId")
      VALUES (${normalized}, ${activeNamespaceId})
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      DELETE FROM "FederationNamespaceCandidate"
      WHERE "nextDomain" = ${normalized}
    `);
    return activeNamespaceId;
  }

  private async activateNamespaceInTx(
    tx: DatabaseTransaction,
    normalized: string,
    namespaceId: number,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE "IdentityNamespace"
      SET active = false,
          "peerAcceptanceConfirmed" = false,
          "remoteServiceReachable" = false
      WHERE domain = ${normalized}
        AND active = true
        AND id <> ${namespaceId}
    `);
    await tx.execute(sql`
      UPDATE "IdentityNamespace"
      SET active = true,
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
      WHERE id = ${namespaceId}
        AND domain = ${normalized}
    `);
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
