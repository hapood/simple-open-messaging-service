import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  DiscoveryService,
  type WellKnownDoc,
} from '../federation/discovery.service.js';
import { SignatureService } from '../federation/signature.service.js';
import { FederationTransportConfigService } from '../federation/federation-transport-config.service.js';
import { ProfileNamespaceFeedService } from '../federation/profile-namespace-feed.service.js';
import { SseService } from '../gateway/sse.service.js';
import { sealBox } from '../federation/sealed-box.js';

export interface AdminIdentityReviewView extends Record<string, unknown> {
  id: number;
  kind: 'domain-rebind' | 'root-rotation' | 'identity-reset';
  matchedNamespaceId: number;
  matchedDomain: string;
  nextDomain: string;
  claimedRoot: string;
  claim: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  /** Computed at query time: whether the reviewed binding still matches the
   *  live epoch (decide() enforces the same condition with distinct failure
   *  codes before applying any decision). */
  epochMatched: boolean;
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

/** Query-time identity matching only. Approval policy (including whether
 * a halt may be cleared) is checked separately inside the decision transaction.
 * Historical reviews remain visible even when their epoch no longer matches. */
const reviewEpochMatched = sql`COALESCE(
  ns.active AND ns."retiredAt" IS NULL AND
  CASE WHEN rev.kind = 'domain-rebind'
    THEN ns."rootPublicKey" = rev."claimedRoot"
      AND ns.domain = rev.claim ->> 'previousDomain'
    ELSE ns."rootPublicKey" = rev.claim ->> 'previousRoot'
      AND ns.domain = rev."nextDomain"
  END, false)`;

const normalizeDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/\.+$/, '');

/** Admin surface for peer identity epochs and their rotation/rebind reviews. */
@Injectable()
export class FederationNamespaceAdminService {
  constructor(
    private readonly database: DatabaseService,
    private readonly profileNamespaceFeed: ProfileNamespaceFeedService,
    private readonly sse: SseService,
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
             ${reviewEpochMatched} AS "epochMatched",
             rev."verifiedAt", rev."reviewedAt", rev."createdAt"
      FROM "FederationIdentityReview" rev
      JOIN "IdentityNamespace" ns ON ns.id = rev."matchedNamespaceId"
      WHERE rev.status = 'pending'
      ORDER BY rev."createdAt" ASC
    `);
    return result.rows;
  }

  /** Approval-time possession proof under the captured predecessor root. */
  private async challengePredecessor(review: AdminIdentityReviewView): Promise<{
    reviewId: number;
    checkedRoot: string;
    ok: boolean;
    detail: string;
  }> {
    const reviewId = review.id;
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
      Uint8Array.from(Buffer.from(checkedRoot, 'base64')),
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
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      const payload = (await response.json().catch(() => undefined)) as
        | { code?: number; data?: { value?: unknown } }
        | undefined;
      if (response.status === 200 && payload?.code === 0) {
        const opened = payload.data?.value;
        const expected = Buffer.from(nonce, 'utf8').toString('base64');
        return {
          reviewId,
          checkedRoot,
          ok: opened === expected,
          detail:
            opened === expected
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

  async approve(
    reviewId: number,
    resolution?: 'new-peer' | 'replace-identity',
  ): Promise<AdminReviewDecisionResult> {
    if (!Number.isSafeInteger(reviewId) || reviewId <= 0) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'reviewId must be a positive integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    // Capture evidence without retaining row locks during outbound I/O. The
    // decision transaction revalidates this snapshot before applying changes.
    const review = await this.database.db.transaction((tx) =>
      this.lockReview(tx, reviewId),
    );
    if (
      review.kind === 'identity-reset' ? !resolution : resolution !== undefined
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'identity-reset requires an explicit new-peer or replace-identity decision',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!this.discovery) {
      throw new BusinessException(
        BusinessCode.INTERNAL,
        'federation discovery is unavailable',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    // Fetch and validate the certificate set before acquiring decision locks.
    // Installing it with the binding avoids a hidden re-handshake prerequisite.
    const document = await this.discovery.fetchWellKnown(review.nextDomain);
    if (review.kind === 'root-rotation') {
      const proof = await this.challengePredecessor(review);
      if (!proof.ok) {
        throw new BusinessException(
          BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
          `predecessor continuity check failed: ${proof.detail}`,
          HttpStatus.CONFLICT,
        );
      }
    }
    return this.decide(reviewId, 'approved', review, document, resolution);
  }

  async reject(reviewId: number): Promise<AdminReviewDecisionResult> {
    return this.decide(reviewId, 'rejected');
  }

  private async decide(
    reviewId: number,
    decision: 'approved' | 'rejected',
    checkedReview?: AdminIdentityReviewView,
    document?: WellKnownDoc,
    resolution?: 'new-peer' | 'replace-identity',
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
      if (
        decision === 'approved' &&
        (!checkedReview ||
          review.kind !== checkedReview.kind ||
          review.matchedNamespaceId !== checkedReview.matchedNamespaceId ||
          review.matchedDomain !== checkedReview.matchedDomain ||
          review.nextDomain !== checkedReview.nextDomain ||
          review.claimedRoot !== checkedReview.claimedRoot ||
          !isDeepStrictEqual(review.claim, checkedReview.claim))
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
          'identity review changed during approval; retry with current evidence',
          HttpStatus.CONFLICT,
        );
      }
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
        (review.kind !== 'domain-rebind' &&
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

      if (
        decision === 'approved' &&
        (!namespace.active ||
          namespace.domain !==
            (review.kind === 'domain-rebind'
              ? review.claim.previousDomain
              : review.nextDomain))
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
          'the identity binding changed during approval',
          HttpStatus.CONFLICT,
        );
      }
      if (decision === 'approved' && review.kind === 'identity-reset') {
        const state = await tx.execute<{ haltCode: number | null }>(sql`
          SELECT "haltCode" FROM "IdentityNamespace" WHERE id = ${namespace.id}
        `);
        if (
          !namespace.active ||
          namespace.domain !== review.nextDomain ||
          namespace.trustLevel !== 'halted' ||
          state.rows[0]?.haltCode !== BusinessCode.FEDERATION_IDENTITY_MISMATCH
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
            'identity-reset no longer matches the halted binding',
            HttpStatus.CONFLICT,
          );
        }
      }
      if (decision === 'approved') {
        const now = Date.now();
        if (
          !document ||
          !document.roots.some(
            (root) =>
              root.ed25519 === review.claimedRoot &&
              root.notBefore <= now &&
              now < root.notAfter,
          ) ||
          !document.keys.some(
            (key) =>
              key.root === review.claimedRoot &&
              key.notBefore <= now &&
              now < key.notAfter,
          )
        ) {
          throw new BusinessException(
            BusinessCode.FEDERATION_BAD_SIGNATURE,
            'the approved binding has no currently valid signing certificate',
            HttpStatus.UNAUTHORIZED,
          );
        }
      }
      let activeNamespaceId: number | null = namespace.id;
      const clientChangeIds: bigint[] = [];
      const newPeer = decision === 'approved' && resolution === 'new-peer';
      if (newPeer) {
        await tx.execute(sql`UPDATE "IdentityNamespace"
          SET active = false, "retiredAt" = now(), "updatedAt" = CURRENT_TIMESTAMP WHERE id = ${namespace.id}`);
        activeNamespaceId = null;
        await this.profileNamespaceFeed.recordNamespaceChangeInTx(
          tx,
          namespace.id,
        );
        clientChangeIds.push(
          await this.profileNamespaceFeed.recordClientChangeInTx(tx, {
            publisherNamespaceId: namespace.id,
            profileNamespaceId: 0,
          }),
        );
      } else if (decision === 'approved' && review.kind === 'domain-rebind') {
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

      if (decision === 'approved') {
        // Keep the direct binding cache in the identity transaction. It must
        // survive a crash before post-commit notifications or refresh work.
        await tx.execute(sql`
          INSERT INTO "ProfileNamespace"
            ("publisherNamespaceId", "profileNamespaceId", domain, "rootPublicKey",
             "sourceGeneratedAt", "updateFeedId", expired, status)
          SELECT id, 0, domain, "rootPublicKey", 0, 0, false,
            CASE WHEN active AND "retiredAt" IS NULL THEN 'ACTIVE' ELSE 'ARCHIVED' END
          FROM "IdentityNamespace" WHERE id = ${namespace.id}
          ON CONFLICT ("publisherNamespaceId", "profileNamespaceId") DO UPDATE
          SET domain = EXCLUDED.domain, "rootPublicKey" = EXCLUDED."rootPublicKey",
              "sourceGeneratedAt" = 0, "updateFeedId" = 0, expired = false,
              status = EXCLUDED.status, "updatedAt" = CURRENT_TIMESTAMP
        `);
      }
      if (
        decision === 'approved' &&
        review.kind === 'identity-reset' &&
        !newPeer
      ) {
        // Explicit administrator identity replacement overrides this identity
        // contradiction only; independently blocked peers were rejected above.
        const coordinate = review.claim.senderAssignedLocalNamespaceId;
        if (
          coordinate !== null &&
          coordinate !== undefined &&
          (typeof coordinate !== 'number' ||
            !Number.isSafeInteger(coordinate) ||
            coordinate <= 0)
        ) {
          throw new BusinessException(
            BusinessCode.VALIDATION_FAILED,
            'invalid reviewed namespace coordinate',
            HttpStatus.BAD_REQUEST,
          );
        }
        await tx.execute(sql`UPDATE "IdentityNamespace" SET
          "updatedAt" = CURRENT_TIMESTAMP,
          "haltCode" = NULL, "haltReason" = NULL, "haltedAt" = NULL,
          "peerAssignedLocalNamespaceId" = ${coordinate ?? null},
          "trustLevel" = CASE WHEN "localServiceAvailable" AND "peerAcceptanceConfirmed"
            THEN 'available' ELSE 'establishing' END
          WHERE id = ${namespace.id}`);
      }
      if (decision === 'approved' && document && !newPeer) {
        const certificates = document.keys.filter(
          (key) => key.root === review.claimedRoot,
        );
        await tx.execute(sql`
          INSERT INTO "S2SKeyCache"
            (domain, "namespaceId", "keyId", "publicKey", root,
             "notBefore", "notAfter", "authorizationSignature")
          VALUES ${sql.join(
            certificates.map(
              (key) => sql`(
              ${review.nextDomain}, ${namespace.id}, ${key.keyId}, ${key.ed25519},
              ${key.root}, ${new Date(key.notBefore)}, ${new Date(key.notAfter)},
              ${key.authorizationSignature}
            )`,
            ),
            sql`, `,
          )}
        `);
      }
      if (decision === 'approved' && !newPeer) {
        // Verified discovery (and predecessor proof for root rotation) proves
        // current reachability, not a new reciprocal acceptance. Never revive
        // an independently halted peer or invent missing acceptance evidence.
        await tx.execute(sql`
          UPDATE "IdentityNamespace"
          SET "updatedAt" = CURRENT_TIMESTAMP, "trustLevel" = CASE
                WHEN "localServiceAvailable" AND "peerAcceptanceConfirmed"
                THEN 'available' ELSE "trustLevel" END,
              "remoteServiceReachable" = true,
              "lastSuccessAt" = now(),
              "degradedAt" = NULL,
              "degradationReason" = NULL
          WHERE id = ${namespace.id} AND active = true AND "trustLevel" <> 'halted'
        `);
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
        // The direct binding and client change are already durable. Third-party
        // caches converge through this publisher's positive namespace item.
        const wakeAt = clientChangeIds.at(-1);
        return {
          result,
          afterCommit: () => {
            if (wakeAt !== undefined)
              this.sse.notifyProfileNamespaceChange(wakeAt);
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
    // Re-binding changes the address of the same peer, not its established
    // acceptance or lifecycle. New-domain certificates are resolved afresh.
    await tx.execute(sql`
      UPDATE "IdentityNamespace"
      SET domain = ${review.nextDomain}, "updatedAt" = CURRENT_TIMESTAMP
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
    // Approval changes the credential of the same peer. Keep acceptance and
    // lifecycle evidence; no reciprocal handshake is required. The unique
    // root index still checks the swap, and stale certificates are removed.
    await tx.execute(sql`
      UPDATE "IdentityNamespace"
      SET "rootPublicKey" = ${review.claimedRoot},
          "identityPinnedAt" = now(), "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${namespace.id}
    `);
    await tx.execute(sql`
      UPDATE "FederationFeedState"
      SET "lastHandshakeAt" = NULL, "latestHealthCheck" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "namespaceId" = ${namespace.id}
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
             ${reviewEpochMatched} AS "epochMatched",
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
