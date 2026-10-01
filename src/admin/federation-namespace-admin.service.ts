import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { FederationRecognitionService } from '../federation/federation-recognition.service.js';
import { DiscoveryService } from '../federation/discovery.service.js';
import { SignatureService } from '../federation/signature.service.js';
import { FederationTransportConfigService } from '../federation/federation-transport-config.service.js';
import { ProfileNamespaceFeedService } from '../federation/profile-namespace-feed.service.js';
import { ProfileNamespaceInfoService } from '../federation/profile-namespace-info.service.js';
import { SseService } from '../gateway/sse.service.js';
import { ed25519PublicKeyToX25519, sealBox } from '../federation/sealed-box.js';

export interface AdminIdentityReviewView extends Record<string, unknown> {
  id: number;
  kind: 'domain-rebind' | 'root-rotation';
  matchedNamespaceId: number;
  matchedDomain: string;
  nextDomain: string;
  claimedRoot: string;
  claim: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  verifiedAt: Date;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface AdminFederationNamespaceView extends Record<string, unknown> {
  id: number;
  domain: string;
  rootPublicKey: string | null;
  peerAssignedLocalNamespaceId: number | null;
  identityPinnedAt: Date | null;
  createdAt: Date;
  retiredAt: Date | null;
  active: boolean;
  trustLevel: string;
  halted: boolean;
  pendingReview: AdminIdentityReviewView | null;
}

export interface AdminReviewDecisionResult {
  reviewId: number;
  status: 'approved' | 'rejected';
  domain: string;
  activeNamespaceId: number | null;
}

const normalizeDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/\.+$/, '');

/** Admin surface for peer identity epochs and their rotation/rebind reviews. */
@Injectable()
export class FederationNamespaceAdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly profileNamespaceFeed: ProfileNamespaceFeedService,
    private readonly profileNamespaceInfo: ProfileNamespaceInfoService,
    private readonly sse: SseService,
    @Optional() private readonly recognition?: FederationRecognitionService,
    @Optional() private readonly discovery?: DiscoveryService,
    @Optional() private readonly signature?: SignatureService,
    @Optional()
    private readonly transportConfig?: FederationTransportConfigService,
  ) {}

  /** List a peer's identity epochs plus any reviews matching its domain or an
   *  arrival domain, newest epoch first. */
  async list(domain: string): Promise<{
    namespaces: AdminFederationNamespaceView[];
    reviews: AdminIdentityReviewView[];
  }> {
    const normalized = this.requireDomain(domain);
    const result = await this.database.db.transaction(async (tx) => {
      const namespaces = await tx.execute<AdminFederationNamespaceView>(sql`
        SELECT ns.id, ns.domain, ns."rootPublicKey", ns."peerAssignedLocalNamespaceId",
               ns."identityPinnedAt", ns."createdAt", ns."retiredAt", ns.active,
               ns."trustLevel",
               (ns."trustLevel" = 'halted') AS halted
        FROM "IdentityNamespace" ns
        WHERE ns.domain = ${normalized} AND ns.id > 0
        ORDER BY ns.active DESC, ns."retiredAt" IS NULL DESC, ns.id DESC
      `);
      const reviews = await this.selectReviews(
        tx,
        sql`(rev."nextDomain" = ${normalized} OR ns.domain = ${normalized})`,
      );
      return { namespaces: namespaces.rows, reviews };
    });
    return result;
  }

  /** All pending identity reviews, oldest first. */
  async pendingReviews(): Promise<AdminIdentityReviewView[]> {
    const result = await this.database.db.execute<AdminIdentityReviewView>(sql`
      SELECT rev.id, rev.kind, rev."matchedNamespaceId", ns.domain AS "matchedDomain",
             rev."nextDomain", rev."claimedRoot", rev.claim, rev.status,
             rev."verifiedAt", rev."reviewedAt", rev."createdAt"
      FROM "FederationIdentityReview" rev
      JOIN "IdentityNamespace" ns ON ns.id = rev."matchedNamespaceId"
      WHERE rev.status = 'pending'
      ORDER BY rev."createdAt" ASC
    `);
    return result.rows;
  }

  /** Continuity check for a pending rotation review (Peer Recognition 4.5):
   *  seal a fresh nonce under the pinned predecessor root and ask the
   *  peer's sealed-challenge service to open it. A correct opening proves
   *  the peer still possesses the predecessor root's private key at check
   *  time. Read-only with respect to review state; the administrator
   *  decides whether the evidence supports approval. */
  async predecessorCheck(reviewId: number): Promise<{
    reviewId: number;
    checkedRoot: string;
    ok: boolean;
    detail: string;
  }> {
    if (!Number.isSafeInteger(reviewId) || reviewId <= 0) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'reviewId must be a positive integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    const review = (
      await this.database.db.transaction((tx) =>
        this.selectReviews(tx, sql`rev.id = ${reviewId}`),
      )
    )[0];
    if (!review) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'identity review not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (review.status !== 'pending') {
      throw new BusinessException(
        BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
        'identity review has already been decided',
        HttpStatus.CONFLICT,
      );
    }
    if (review.kind !== 'root-rotation') {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'predecessor continuity check applies to root-rotation reviews only',
        HttpStatus.BAD_REQUEST,
      );
    }
    const checkedRoot = review.claim.previousRoot as string | undefined;
    if (!checkedRoot || !/^[A-Za-z0-9+/]{43}=$/.test(checkedRoot)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        'the review is missing a usable predecessor root',
        HttpStatus.CONFLICT,
      );
    }
    if (!this.discovery || !this.signature || !this.transportConfig) {
      throw new BusinessException(
        BusinessCode.INTERNAL,
        'federation outbound tooling is unavailable',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    const nonce = randomBytes(32).toString('base64');
    const sealed = sealBox(
      Uint8Array.from(Buffer.from(nonce, 'utf8')),
      ed25519PublicKeyToX25519(
        Uint8Array.from(Buffer.from(checkedRoot, 'base64')),
      ),
    );
    const body = JSON.stringify({
      publicKey: checkedRoot,
      encryptedValue: Buffer.from(sealed).toString('base64'),
    });
    let base: string;
    try {
      base = await this.discovery.resolveBase(review.nextDomain);
    } catch (error) {
      return {
        reviewId,
        checkedRoot,
        ok: false,
        detail: `discovery failed: ${(error as Error).message}`,
      };
    }
    const url = new URL(`${base}/s2s/v1/verify`);
    const release = await this.discovery.acquireRequestSlot(review.nextDomain);
    try {
      const headers = await this.signature.signOutbound({
        method: 'POST',
        url,
        body,
      });
      const response = await this.discovery.request(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(
          this.transportConfig.get().callTimeoutSec * 1000,
        ),
      });
      const payload = (await response.json().catch(() => undefined)) as
        | { code?: number; data?: { value?: unknown } }
        | undefined;
      if (response.status === 200 && payload?.code === 0) {
        const opened = payload.data?.value;
        return {
          reviewId,
          checkedRoot,
          ok: opened === nonce,
          detail:
            opened === nonce
              ? 'the peer opened the sealed challenge under the pinned predecessor root'
              : 'the peer answered without the expected plaintext',
        };
      }
      return {
        reviewId,
        checkedRoot,
        ok: false,
        detail: `verify answered HTTP ${response.status} code ${payload?.code ?? 'n/a'}`,
      };
    } catch (error) {
      return {
        reviewId,
        checkedRoot,
        ok: false,
        detail: `verify call failed: ${(error as Error).message}`,
      };
    } finally {
      release();
    }
  }

  async approve(reviewId: number): Promise<AdminReviewDecisionResult> {
    const decision = await this.decide(reviewId, 'approved');
    void this.recognition?.recognize(decision.domain).catch(() => undefined);
    return decision;
  }

  async reject(reviewId: number): Promise<AdminReviewDecisionResult> {
    return this.decide(reviewId, 'rejected');
  }

  private async decide(
    reviewId: number,
    decision: 'approved' | 'rejected',
  ): Promise<AdminReviewDecisionResult> {
    if (!Number.isSafeInteger(reviewId) || reviewId <= 0) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'reviewId must be a positive integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    const outcome = await this.database.db.transaction(async (tx) => {
      const review = await this.lockReview(tx, reviewId);
      const namespace = (
        await tx.execute<{
          id: number;
          domain: string;
          rootPublicKey: string | null;
          peerAssignedLocalNamespaceId: number | null;
          identityPinnedAt: Date | null;
          retiredAt: Date | null;
          active: boolean;
          trustLevel: string;
        }>(sql`
          SELECT id, domain, "rootPublicKey", "peerAssignedLocalNamespaceId",
                 "identityPinnedAt", "retiredAt", active, "trustLevel"
          FROM "IdentityNamespace"
          WHERE id = ${review.matchedNamespaceId}
          FOR NO KEY UPDATE
        `)
      ).rows[0];
      if (!namespace) {
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          'the matched identity epoch no longer exists',
          HttpStatus.CONFLICT,
        );
      }
      if (namespace.retiredAt) {
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          'the matched identity epoch is already retired',
          HttpStatus.CONFLICT,
        );
      }
      if (
        (review.kind === 'root-rotation' &&
          namespace.rootPublicKey !==
            (review.claim.previousRoot as string | undefined)) ||
        (review.kind === 'domain-rebind' &&
          namespace.rootPublicKey !== review.claimedRoot)
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          'the identity epoch no longer matches the reviewed evidence',
          HttpStatus.CONFLICT,
        );
      }

      let activeNamespaceId: number | null = namespace.id;
      const clientChangeIds: bigint[] = [];
      if (decision === 'approved' && review.kind === 'domain-rebind') {
        activeNamespaceId = await this.applyDomainRebind(
          tx,
          review,
          namespace,
          clientChangeIds,
        );
      } else if (decision === 'approved') {
        activeNamespaceId = await this.applyRootRotation(
          tx,
          review,
          {
            id: namespace.id,
          },
          clientChangeIds,
        );
      } else if (review.kind === 'root-rotation') {
        // Rejecting a rotation leaves the pinned epoch untouched: the peer
        // keeps serving predecessor-authorized traffic only until it either
        // retries with fresh evidence or the admin resets the namespace.
        activeNamespaceId = namespace.id;
      } else {
        // Rejecting a re-bind keeps the current domain binding.
        activeNamespaceId = namespace.id;
      }

      await tx.execute(sql`
        UPDATE "FederationIdentityReview"
        SET status = ${decision}, "reviewedAt" = now(), "updatedAt" = now()
        WHERE id = ${reviewId}
      `);
      const result: AdminReviewDecisionResult = {
        reviewId,
        status: decision,
        domain: review.nextDomain,
        activeNamespaceId,
      };
      if (decision === 'approved') {
        // Our own pin for this peer is authoritative: wake every device via
        // the change feed and converge the (our-id-for-peer, 0) cache row
        // locally, without a remote call. Third-party rows wait for the
        // peer's own feed.
        const wakeAt = clientChangeIds.at(-1);
        return {
          result,
          afterCommit: () => {
            if (wakeAt !== undefined)
              this.sse.notifyProfileNamespaceChange(wakeAt);
            this.profileNamespaceInfo.scheduleRefresh(
              {
                publisherNamespaceId: namespace.id,
                profileNamespaceId: 0,
              },
              0n,
            );
          },
        };
      }
      return { result, afterCommit: () => undefined };
    });
    outcome.afterCommit();
    return outcome.result;
  }

  private async applyDomainRebind(
    tx: DatabaseTransaction,
    review: AdminIdentityReviewView,
    namespace: { id: number; domain: string },
    clientChangeIds: bigint[],
  ): Promise<number> {
    const conflicting = await tx.execute<{ id: number }>(sql`
      SELECT id FROM "IdentityNamespace"
      WHERE domain = ${review.nextDomain}
        AND id > 0
        AND id <> ${namespace.id}
        AND active = true
      FOR NO KEY UPDATE
    `);
    if (conflicting.rows.length > 0) {
      throw new BusinessException(
        BusinessCode.FEDERATION_DOMAIN_CONFLICT,
        `${review.nextDomain} is already bound to another peer identity`,
        HttpStatus.CONFLICT,
      );
    }
    // Re-binding keeps the same epoch: the pin stays, the domain binding and
    // availability state move to the arrival domain.
    await tx.execute(sql`
      UPDATE "IdentityNamespace"
      SET domain = ${review.nextDomain},
          "trustLevel" = 'establishing',
          "peerAcceptanceConfirmed" = false,
          "remoteServiceReachable" = false,
          "lastSuccessAt" = NULL,
          "degradedAt" = NULL,
          "degradationReason" = NULL
      WHERE id = ${namespace.id}
    `);
    await tx.execute(sql`
      DELETE FROM "S2SKeyCache" WHERE "namespaceId" = ${namespace.id}
    `);
    // The re-bind is one binding change on a stable nsid: publish it on the
    // shared feed in the same commit, and tell every device the peer's own
    // binding (the nsid-0 pair in this publisher's space) changed.
    await this.profileNamespaceFeed.recordNamespaceChangeInTx(tx, namespace.id);
    clientChangeIds.push(
      await this.profileNamespaceFeed.recordClientChangeInTx(tx, {
        publisherNamespaceId: namespace.id,
        profileNamespaceId: 0,
      }),
    );
    return namespace.id;
  }

  private async applyRootRotation(
    tx: DatabaseTransaction,
    review: AdminIdentityReviewView,
    namespace: { id: number },
    clientChangeIds: bigint[],
  ): Promise<number> {
    const pinned = await tx.execute<{ id: number }>(sql`
      SELECT id FROM "IdentityNamespace"
      WHERE "rootPublicKey" = ${review.claimedRoot}
        AND id > 0
        AND "retiredAt" IS NULL
        AND id <> ${namespace.id}
      FOR NO KEY UPDATE
    `);
    if (pinned.rows.length > 0) {
      throw new BusinessException(
        BusinessCode.FEDERATION_DOMAIN_CONFLICT,
        'the claimed root is already pinned to an active identity epoch',
        HttpStatus.CONFLICT,
      );
    }
    // Review-approved in-place root replacement: nsids are lifelong, so the
    // epoch row keeps its id and every business fact bound to it; only the
    // pinned key moves. Availability state resets exactly like a re-bind so
    // probes re-establish reachability before the peer is served again, and
    // the partial unique index on "rootPublicKey" re-checks the swap at
    // commit time.
    await tx.execute(sql`
      UPDATE "IdentityNamespace"
      SET "rootPublicKey" = ${review.claimedRoot},
          "identityPinnedAt" = now(),
          "trustLevel" = 'establishing',
          "peerAcceptanceConfirmed" = false,
          "remoteServiceReachable" = false,
          "lastSuccessAt" = NULL,
          "degradedAt" = NULL,
          "degradationReason" = NULL
      WHERE id = ${namespace.id}
    `);
    await tx.execute(sql`
      DELETE FROM "S2SKeyCache" WHERE "namespaceId" = ${namespace.id}
    `);
    // The in-place key swap is one binding change on a stable nsid: publish
    // it on the shared feed in the same commit, and tell every device the
    // peer's own binding (the nsid-0 pair in this publisher's space) changed.
    await this.profileNamespaceFeed.recordNamespaceChangeInTx(tx, namespace.id);
    clientChangeIds.push(
      await this.profileNamespaceFeed.recordClientChangeInTx(tx, {
        publisherNamespaceId: namespace.id,
        profileNamespaceId: 0,
      }),
    );
    return namespace.id;
  }

  private async lockReview(
    tx: DatabaseTransaction,
    reviewId: number,
  ): Promise<AdminIdentityReviewView> {
    const locked = (
      await this.selectReviews(tx, sql`rev.id = ${reviewId}`, true)
    )[0];
    if (!locked) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'identity review not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (locked.status !== 'pending') {
      throw new BusinessException(
        BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
        'identity review has already been decided',
        HttpStatus.CONFLICT,
      );
    }
    return locked;
  }

  private async selectReviews(
    tx: DatabaseTransaction,
    condition: ReturnType<typeof sql>,
    forUpdate = false,
  ): Promise<AdminIdentityReviewView[]> {
    const result = await tx.execute<AdminIdentityReviewView>(sql`
      SELECT rev.id, rev.kind, rev."matchedNamespaceId", ns.domain AS "matchedDomain",
             rev."nextDomain", rev."claimedRoot", rev.claim, rev.status,
             rev."verifiedAt", rev."reviewedAt", rev."createdAt"
      FROM "FederationIdentityReview" rev
      JOIN "IdentityNamespace" ns ON ns.id = rev."matchedNamespaceId"
      WHERE ${condition}
      ORDER BY rev."createdAt" DESC
      ${forUpdate ? sql`FOR NO KEY UPDATE OF rev` : sql``}
    `);
    return result.rows;
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
