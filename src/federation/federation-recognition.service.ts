import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, desc, eq, getTableColumns, isNull, or, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import * as tables from '../database/schema.js';
import {
  currentCertifyingRoots,
  DiscoveryService,
} from './discovery.service.js';
import { parsePeerErrorBody } from './federation-errors.js';
import {
  FEDERATION_PEER_AVAILABLE,
  type FederationPeerAvailable,
} from './federation-peer.events.js';
import {
  SignatureService,
  type OutboundSignatureHeaders,
  type SignedRequest,
} from './signature.service.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';
import {
  FederationNamespaceService,
  type FederationContext,
  type VerifiedFederationNamespace,
} from './federation-namespace.service.js';

export type FederationHealthStatus = 'available' | 'degraded' | 'unavailable';

type PositivePeerStatus = Exclude<FederationHealthStatus, 'unavailable'>;

interface PositivePeerResult {
  status: PositivePeerStatus;
  peerAssignedLocalNamespaceId: number;
}

interface UnavailablePeerResult {
  status: 'unavailable';
}

type HealthResult = PositivePeerResult | UnavailablePeerResult;

type RecognizeFailed = {
  ok: false;
  status: 'failed';
  code: number;
  message: string;
};

type RecognizeResult =
  | {
      ok: true;
      status: 'pending';
      message?: string;
    }
  | {
      ok: true;
      status: 'recognized';
      peerAssignedLocalNamespaceId: number;
    }
  | RecognizeFailed;

export type OutboundRecognizeResult =
  | { domain: string; status: 'pending'; message?: string }
  | { domain: string; status: 'recognized' };

export type FederationRecognitionStage =
  | 'DISCOVERING'
  | 'VERIFYING_IDENTITY'
  | 'CONNECTING';

@Injectable()
export class FederationRecognitionService {
  private readonly logger = new Logger(FederationRecognitionService.name);
  private readonly inFlight = new Map<
    string,
    Promise<OutboundRecognizeResult>
  >();
  private readonly healthInFlight = new Map<
    string,
    Promise<FederationHealthStatus>
  >();
  private readonly inboundRecognizeInFlight = new Map<string, Promise<void>>();
  private readonly progress = new Map<
    string,
    {
      latest: FederationRecognitionStage;
      listeners: Set<(stage: FederationRecognitionStage) => void>;
    }
  >();

  constructor(
    private readonly database: DatabaseService,
    private readonly discovery: DiscoveryService,
    private readonly signature: SignatureService,
    private readonly transportConfig: FederationTransportConfigService,
    private readonly namespaces: FederationNamespaceService,
    private readonly events: EventEmitter2,
  ) {}

  async recognize(peerDomain: string): Promise<OutboundRecognizeResult> {
    const domain = this.normalizeDomain(peerDomain);
    const existing = this.inFlight.get(domain);
    if (existing) return existing;
    const run = this.runRecognize(domain).finally(() => {
      if (this.inFlight.get(domain) === run) this.inFlight.delete(domain);
      this.progress.delete(domain);
    });
    this.inFlight.set(domain, run);
    return run;
  }

  captureContext(peerDomain: string): Promise<FederationContext> {
    return this.namespaces.captureActive(this.normalizeDomain(peerDomain));
  }

  captureVerifiedContext(
    peerDomain: string,
  ): Promise<VerifiedFederationNamespace> {
    const domain = this.normalizeDomain(peerDomain);
    return this.database.db.transaction((tx) =>
      this.namespaces.captureVerifiedInTx(tx, domain),
    );
  }

  /** Observe the domain-level bootstrap only. A re-entrant caller immediately receives the latest
   * stage of an already-running recognition, while account lookup/result data remains request-local. */
  subscribeProgress(
    peerDomain: string,
    listener: (stage: FederationRecognitionStage) => void,
  ): () => void {
    const domain = this.normalizeDomain(peerDomain);
    let state = this.progress.get(domain);
    if (!state) {
      state = { latest: 'DISCOVERING', listeners: new Set() };
      this.progress.set(domain, state);
    }
    state.listeners.add(listener);
    listener(state.latest);
    return () => {
      state?.listeners.delete(listener);
      if (state?.listeners.size === 0 && !this.inFlight.has(domain)) {
        this.progress.delete(domain);
      }
    };
  }

  private publishProgress(
    domain: string,
    stage: FederationRecognitionStage,
  ): void {
    let state = this.progress.get(domain);
    if (!state) {
      state = { latest: stage, listeners: new Set() };
      this.progress.set(domain, state);
    } else {
      state.latest = stage;
    }
    for (const listener of state.listeners) listener(stage);
  }

  async recover(peerDomain: string): Promise<void> {
    const domain = this.normalizeDomain(peerDomain);
    const peer = await this.database.db.query.identityNamespace.findFirst({
      where: eq(tables.identityNamespace.domain, domain),
      columns: {
        id: true,
        peerAcceptanceConfirmed: true,
        localServiceAvailable: true,
      },
    });
    // Health can confirm peer acceptance only after local identity preparation.
    if (!peer || !peer.localServiceAvailable) {
      await this.recognize(domain);
      return;
    }
    const status = await this.checkHealth(domain);
    if (status === 'unavailable' && !peer.peerAcceptanceConfirmed)
      await this.recognize(domain);
  }

  async submitInboundRecognize(params: {
    domain: string;
    keyId: string;
    claimedRoot: string;
    signedRequest: SignedRequest;
    headers: OutboundSignatureHeaders;
    senderAssignedLocalNamespaceId?: number;
    signatureExpires: number;
  }): Promise<RecognizeResult> {
    const domain = this.normalizeDomain(params.domain);
    // Recognition is deliberately database-authoritative.  The in-flight map
    // coalesces expensive verification, while the committed namespace row is
    // the source of truth for a later request.
    const review = await this.findReviewForDomain(domain);
    if (review?.status === 'pending') {
      return {
        ok: true,
        status: 'pending',
        message: 'waiting for administrator approval',
      };
    }
    if (review && review.status === 'rejected') {
      return {
        ok: false,
        status: 'failed',
        code:
          review.kind === 'root-rotation'
            ? BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED
            : BusinessCode.FEDERATION_DOMAIN_CHANGE_REJECTED,
        message:
          review.kind === 'root-rotation'
            ? 'root rotation rejected by administrator review'
            : 'domain re-binding rejected by administrator review',
      };
    }
    const recognized = await this.readRecognizedInbound(
      domain,
      params.claimedRoot,
    );
    if (recognized) return recognized;

    const identityKey = `${domain}/${params.claimedRoot}/${params.keyId}`;
    if (!this.inboundRecognizeInFlight.has(identityKey)) {
      const run = this.verifyInboundRecognize({ ...params, domain }).finally(
        () => {
          if (this.inboundRecognizeInFlight.get(identityKey) === run) {
            this.inboundRecognizeInFlight.delete(identityKey);
          }
        },
      );
      this.inboundRecognizeInFlight.set(identityKey, run);
      void run.catch((error) => {
        const failure = this.toRecognizeFailure(error);
        this.logger.warn(
          `Recognize ${domain} verification failed: ${failure.message}`,
        );
      });
    }
    return {
      ok: true,
      status: 'pending',
      message: 'verification in progress',
    };
  }

  async checkHealth(peerDomain: string): Promise<FederationHealthStatus> {
    const domain = this.normalizeDomain(peerDomain);
    const existing = this.healthInFlight.get(domain);
    if (existing) return existing;
    const run = this.runHealthCheck(domain).finally(() => {
      if (this.healthInFlight.get(domain) === run) {
        this.healthInFlight.delete(domain);
      }
    });
    this.healthInFlight.set(domain, run);
    return run;
  }

  private async runHealthCheck(
    domain: string,
  ): Promise<FederationHealthStatus> {
    let base: string;
    try {
      base = await this.discovery.resolveBase(domain);
    } catch (error) {
      await this.markTransportDegraded(
        domain,
        `Health discovery: ${(error as Error).message}`,
      );
      throw error;
    }
    const url = new URL(`${base}/s2s/v1/health`);
    const body = '';
    const release = await this.discovery.acquireRequestSlot(domain);
    try {
      const headers = await this.signature.signOutbound({
        method: 'GET',
        url,
        body,
      });
      let response: Response;
      try {
        response = await this.discovery.request(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(
            this.transportConfig.get().callTimeoutSec * 1000,
          ),
        });
      } catch (error) {
        await this.markTransportDegraded(
          domain,
          `Health network/timeout: ${(error as Error).message}`,
        );
        throw error;
      }
      if (response.status !== 200) {
        // Any non-200 Health — including 401 FEDERATION_BAD_SIGNATURE — only removes
        // current reachability. It never halts, never drops pins or acceptance
        // evidence, and must not trigger a well-known refresh in the hope of
        // repairing the peer's cache of the local key.
        await this.markTransportDegraded(
          domain,
          `Health HTTP ${response.status}`,
        );
        throw new Error(`Health ${domain} returned HTTP ${response.status}`);
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        value = undefined;
      }
      const result = this.parseHealthResult(value);
      if (!result) {
        await this.markTransportDegraded(domain, 'Health malformed response');
        throw new Error(`Health ${domain} returned malformed response`);
      }
      if (result.status !== 'unavailable') {
        await this.recordPeerAssignedLocalNamespace(
          domain,
          result.peerAssignedLocalNamespaceId,
        );
      }
      await this.applyHealthResult(domain, result.status);
      return result.status;
    } finally {
      release();
    }
  }

  private async verifyInboundRecognize(params: {
    domain: string;
    keyId: string;
    claimedRoot: string;
    signedRequest: SignedRequest;
    headers: OutboundSignatureHeaders;
    senderAssignedLocalNamespaceId?: number;
    signatureExpires: number;
  }): Promise<void> {
    const normalized = this.normalizeDomain(params.domain);
    const doc = await this.discovery.fetchWellKnown(normalized);
    const now = Date.now();
    const certificate = doc.keys.find(
      (key) =>
        key.keyId === params.keyId &&
        key.notBefore <= now &&
        now < key.notAfter,
    );
    if (!certificate) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        `keyId ${params.keyId} is not currently authorized`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    // The claimed root must be a currently valid group entry and must be the
    // root that authorizes the signing certificate (recognition 4.4).
    const claimedEntry = doc.roots.find(
      (entry) => entry.ed25519 === params.claimedRoot,
    );
    if (
      !claimedEntry ||
      !(claimedEntry.notBefore <= now && now < claimedEntry.notAfter) ||
      certificate.root !== params.claimedRoot
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        'claimed root does not authorize the signing certificate',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const claimedRoot = params.claimedRoot;
    if (
      !(await this.signature.verifyWithKey(
        params.signedRequest,
        params.headers,
        Uint8Array.from(Buffer.from(certificate.ed25519, 'base64')),
      ))
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        'signature verification failed',
        HttpStatus.UNAUTHORIZED,
      );
    }
    // --- Root-identity resolution (recognition 4.4) ---
    const [domainEpoch] = await this.database.db
      .select({
        id: tables.identityNamespace.id,
        domain: tables.identityNamespace.domain,
        rootPublicKey: tables.identityNamespace.rootPublicKey,
        peerAssignedLocalNamespaceId:
          tables.identityNamespace.peerAssignedLocalNamespaceId,
      })
      .from(tables.identityNamespace)
      .where(
        and(
          eq(tables.identityNamespace.domain, normalized),
          eq(tables.identityNamespace.active, true),
          isNull(tables.identityNamespace.retiredAt),
          sql`${tables.identityNamespace.id} > 0`,
        ),
      )
      .limit(1);
    const [rootEpoch] = await this.database.db
      .select({
        id: tables.identityNamespace.id,
        domain: tables.identityNamespace.domain,
        peerAssignedLocalNamespaceId:
          tables.identityNamespace.peerAssignedLocalNamespaceId,
      })
      .from(tables.identityNamespace)
      .where(
        and(
          eq(tables.identityNamespace.rootPublicKey, claimedRoot),
          isNull(tables.identityNamespace.retiredAt),
          sql`${tables.identityNamespace.id} > 0`,
        ),
      )
      .limit(1);

    const requireCoordinateMatch = (epoch: {
      peerAssignedLocalNamespaceId: number | null;
    }): void => {
      if (
        params.senderAssignedLocalNamespaceId !== undefined &&
        epoch.peerAssignedLocalNamespaceId !== null &&
        params.senderAssignedLocalNamespaceId !==
          epoch.peerAssignedLocalNamespaceId
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          `${normalized} sender-assigned local namespace does not match pinned identity`,
          HttpStatus.CONFLICT,
        );
      }
    };

    if (rootEpoch && rootEpoch.domain === normalized) {
      // Claimed root already pinned and bound to this domain: ordinary
      // idempotent re-recognition; commit acceptance directly.
      requireCoordinateMatch({
        peerAssignedLocalNamespaceId: rootEpoch.peerAssignedLocalNamespaceId,
      });
      const context = await this.acceptInbound(
        normalized,
        claimedRoot,
        params.senderAssignedLocalNamespaceId,
      );
      await this.discovery.cacheDocument(normalized, context.namespaceId, doc);
      return;
    }

    if (rootEpoch) {
      // Claimed root pinned under a different domain: domain re-binding
      // arrival (recognition 4.4). The hostname-verified fetch already
      // performed is the proof of control over the new domain. The sender-
      // assigned coordinate is recorded in the pending review, not rejected
      // against the old domain binding: a re-binding may legitimately carry
      // the coordinate assigned for the new binding.
      if (
        domainEpoch &&
        domainEpoch.id !== rootEpoch.id &&
        domainEpoch.rootPublicKey !== claimedRoot
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_DOMAIN_CONFLICT,
          `${normalized} is already bound to another peer identity`,
          HttpStatus.CONFLICT,
        );
      }
      await this.recordReview({
        kind: 'domain-rebind',
        matchedNamespaceId: rootEpoch.id,
        nextDomain: normalized,
        claimedRoot,
        claim: {
          previousDomain: rootEpoch.domain,
          claimedRoot,
          rootGroup: doc.roots,
          senderAssignedLocalNamespaceId:
            params.senderAssignedLocalNamespaceId ?? null,
          arrivedAt: new Date().toISOString(),
        },
      });
      return;
    }

    if (domainEpoch) {
      // Root not pinned anywhere, but this domain has an epoch: a root
      // rotation arrival when the fetched group still contains the pin as a
      // currently valid entry (recognition 4.5); otherwise the peer dropped
      // our pin from its group, which is an identity contradiction.
      requireCoordinateMatch({
        peerAssignedLocalNamespaceId: domainEpoch.peerAssignedLocalNamespaceId,
      });
      const pinEntry = doc.roots.find(
        (entry) => entry.ed25519 === domainEpoch.rootPublicKey,
      );
      const pinStillValid =
        pinEntry !== undefined &&
        pinEntry.notBefore <= now &&
        now < pinEntry.notAfter;
      if (!pinStillValid) {
        const message = `${normalized} no longer publishes the pinned root in its group`;
        await this.database.db
          .update(tables.identityNamespace)
          .set({
            trustLevel: 'halted',
            remoteServiceReachable: false,
            haltedAt: new Date(),
            haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
            haltReason: message,
          })
          .where(eq(tables.identityNamespace.id, domainEpoch.id));
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          message,
          HttpStatus.CONFLICT,
        );
      }
      await this.recordReview({
        kind: 'root-rotation',
        matchedNamespaceId: domainEpoch.id,
        nextDomain: normalized,
        claimedRoot,
        claim: {
          previousRoot: domainEpoch.rootPublicKey,
          claimedRoot,
          rootGroup: doc.roots,
          senderAssignedLocalNamespaceId:
            params.senderAssignedLocalNamespaceId ?? null,
          arrivedAt: new Date().toISOString(),
        },
      });
      // A rotation review leaves the pinned epoch exactly as it is: ordinary
      // admission keeps authenticating predecessor-authorized certificates
      // only, and successor-root traffic fails authentication with 401.
      return;
    }

    // Unknown domain, unpinned root: ordinary first recognition. The
    // coordinate value, if any, is a first disclosure, not a consistency
    // check.
    const context = await this.acceptInbound(
      normalized,
      claimedRoot,
      params.senderAssignedLocalNamespaceId,
    );
    await this.discovery.cacheDocument(normalized, context.namespaceId, doc);
    return;
  }

  private async readRecognizedInbound(
    domain: string,
    claimedRoot: string,
  ): Promise<Extract<RecognizeResult, { status: 'recognized' }> | null> {
    const query = this.database.db.query?.identityNamespace;
    if (!query) return null;
    const peer = await query.findFirst({
      where: and(
        eq(tables.identityNamespace.domain, domain),
        eq(tables.identityNamespace.rootPublicKey, claimedRoot),
        eq(tables.identityNamespace.active, true),
        isNull(tables.identityNamespace.retiredAt),
      ),
      columns: {
        id: true,
        peerAssignedLocalNamespaceId: true,
        peerAcceptanceConfirmed: true,
        localServiceAvailable: true,
        trustLevel: true,
      },
    });
    return !peer ||
      peer.peerAssignedLocalNamespaceId === null ||
      !peer.peerAcceptanceConfirmed ||
      !peer.localServiceAvailable ||
      peer.trustLevel === 'halted'
      ? null
      : {
          ok: true,
          status: 'recognized',
          // Tell the sender how this receiver numbers it, not the reverse coordinate.
          peerAssignedLocalNamespaceId: peer.id,
        };
  }

  /** Latest review relevant to arrivals from one domain: open reviews first,
   *  otherwise the most recently resolved one. */
  private async findReviewForDomain(domain: string) {
    const rows = await this.database.db
      .select({
        id: tables.federationIdentityReview.id,
        kind: tables.federationIdentityReview.kind,
        status: tables.federationIdentityReview.status,
      })
      .from(tables.federationIdentityReview)
      .innerJoin(
        tables.identityNamespace,
        eq(
          tables.identityNamespace.id,
          tables.federationIdentityReview.matchedNamespaceId,
        ),
      )
      .where(
        or(
          eq(tables.federationIdentityReview.nextDomain, domain),
          eq(tables.identityNamespace.domain, domain),
        ),
      )
      .orderBy(desc(tables.federationIdentityReview.updatedAt))
      .limit(1);
    return rows[0];
  }

  /** Idempotently record one review fact for a matched namespace; a repeated
   *  coherent arrival refreshes the claim snapshot of the open review. */
  private async recordReview(params: {
    kind: 'domain-rebind' | 'root-rotation';
    matchedNamespaceId: number;
    nextDomain: string;
    claimedRoot: string;
    claim: Record<string, unknown>;
  }): Promise<void> {
    const now = new Date();
    await this.database.db.transaction(async (tx) => {
      await tx
        .insert(tables.federationIdentityReview)
        .values({
          kind: params.kind,
          matchedNamespaceId: params.matchedNamespaceId,
          nextDomain: params.nextDomain,
          claimedRoot: params.claimedRoot,
          claim: params.claim,
          status: 'pending',
          verifiedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [tables.federationIdentityReview.matchedNamespaceId],
          targetWhere: sql`${tables.federationIdentityReview.status} = 'pending'`,
          set: {
            nextDomain: params.nextDomain,
            claimedRoot: params.claimedRoot,
            claim: params.claim,
            verifiedAt: now,
            updatedAt: now,
          },
        });
      // Publish a domain review and its pending lifecycle together. A reader
      // must never observe a committed review with the previous acceptance
      // evidence. Keep review -> namespace lock order, matching admin decisions.
      // Root rotation deliberately leaves the predecessor epoch untouched.
      if (params.kind === 'domain-rebind') {
        await tx
          .update(tables.identityNamespace)
          .set({
            trustLevel: 'pending',
            localServiceAvailable: true,
            peerAcceptanceConfirmed: false,
            remoteServiceReachable: false,
          })
          .where(eq(tables.identityNamespace.id, params.matchedNamespaceId));
      }
    });
  }

  async acceptInbound(
    domain: string,
    rootPublicKey: string,
    senderAssignedLocalNamespaceId?: number,
  ): Promise<VerifiedFederationNamespace> {
    const normalized = this.normalizeDomain(domain);
    let restored = false;
    const mismatch = await this.database.db.transaction(async (tx) => {
      const peer = await this.lockPeer(tx, normalized);
      this.assertPolicyAllowsRecognition(peer, normalized);
      if (peer?.identityPinnedAt && peer.rootPublicKey !== rootPublicKey) {
        await this.markIdentityLostInTx(tx, normalized);
        return { mismatch: true as const };
      }
      const now = new Date();
      const next = {
        ...peer,
        identityPinnedAt: peer?.identityPinnedAt ?? now,
        peerAcceptanceConfirmed: true,
        localServiceAvailable: true,
        remoteServiceReachable: true,
      };
      const trustLevel = this.lifecycle(next);
      restored = this.didRecover(peer, trustLevel);
      const context = await this.namespaces.activateVerifiedInTx(tx, {
        domain: normalized,
        rootPublicKey,
        identityPinnedAt: peer?.identityPinnedAt ?? now,
      });
      // The sender discloses the namespace its local store allocated for this
      // server. A disclosure that contradicts the value already pinned for this
      // identity epoch is an identity contradiction; when no value is pinned
      // yet, the disclosure is adopted below.
      if (
        senderAssignedLocalNamespaceId !== undefined &&
        peer &&
        peer.peerAssignedLocalNamespaceId !== null &&
        senderAssignedLocalNamespaceId !== peer.peerAssignedLocalNamespaceId
      ) {
        await this.markIdentityLostInTx(tx, normalized);
        return { mismatch: true as const };
      }
      await tx
        .update(tables.identityNamespace)
        .set({
          peerAcceptanceConfirmed: true,
          localServiceAvailable: true,
          remoteServiceReachable: true,
          lastSuccessAt: now,
          degradedAt: null,
          degradationReason: null,
          trustLevel,
          trustedAt:
            trustLevel === 'available'
              ? (peer?.trustedAt ?? now)
              : peer?.trustedAt,
          ...(senderAssignedLocalNamespaceId !== undefined
            ? {
                peerAssignedLocalNamespaceId: senderAssignedLocalNamespaceId,
              }
            : {}),
        })
        .where(eq(tables.identityNamespace.id, context.namespaceId));
      return { mismatch: false as const, context };
    });
    if (mismatch.mismatch) this.throwIdentityMismatch(normalized);
    if (restored)
      this.logger.log(`Recognize ${normalized}: degraded → available`);
    this.emitPeerAvailable(normalized);
    return mismatch.context;
  }

  async queryHealth(domain: string): Promise<FederationHealthStatus> {
    const peer = await this.database.db.query.identityNamespace.findFirst({
      where: eq(tables.identityNamespace.domain, this.normalizeDomain(domain)),
    });
    if (
      !peer ||
      peer.id === null ||
      !peer.localServiceAvailable ||
      peer.trustLevel === 'halted'
    ) {
      return 'unavailable';
    }
    return peer.remoteServiceReachable ? 'available' : 'degraded';
  }

  async hasPreparedPeer(domain: string): Promise<boolean> {
    const peer = await this.database.db.query.identityNamespace.findFirst({
      where: eq(tables.identityNamespace.domain, this.normalizeDomain(domain)),
      columns: {
        id: true,
        trustLevel: true,
        localServiceAvailable: true,
      },
    });
    return (
      peer?.id != null &&
      peer.trustLevel !== 'halted' &&
      peer.localServiceAvailable
    );
  }

  async applyHealthResult(
    domain: string,
    result: FederationHealthStatus,
  ): Promise<void> {
    const normalized = this.normalizeDomain(domain);
    if (result === 'unavailable') {
      await this.markTransportDegraded(normalized, 'Health unavailable');
      return;
    }
    let recovered = false;
    let restored = false;
    await this.database.db.transaction(async (tx) => {
      const peer = await this.lockPeer(tx, normalized);
      if (
        !peer ||
        !peer.identityPinnedAt ||
        !peer.localServiceAvailable ||
        peer.trustLevel === 'halted'
      )
        return;
      const now = new Date();
      const next = {
        ...peer,
        peerAcceptanceConfirmed: true,
        remoteServiceReachable: true,
      };
      const trustLevel = this.lifecycle(next);
      recovered = peer.trustLevel !== 'available' && trustLevel === 'available';
      restored = this.didRecover(peer, trustLevel);
      await tx
        .update(tables.identityNamespace)
        .set({
          peerAcceptanceConfirmed: true,
          remoteServiceReachable: true,
          lastSuccessAt: now,
          degradedAt: null,
          degradationReason: null,
          trustLevel,
          trustedAt:
            trustLevel === 'available'
              ? (peer.trustedAt ?? now)
              : peer.trustedAt,
        })
        .where(
          and(
            eq(tables.identityNamespace.domain, normalized),
            eq(tables.identityNamespace.active, true),
          ),
        );
    });
    // Emitted post-commit when Health restores reachability or first proves peer acceptance.
    if (restored) this.logger.log(`Health ${normalized}: degraded → available`);
    if (recovered) this.emitPeerAvailable(normalized);
  }

  async markReachable(domain: string): Promise<void> {
    const normalized = this.normalizeDomain(domain);
    let restored = false;
    await this.database.db.transaction(async (tx) => {
      const peer = await this.lockPeer(tx, normalized);
      if (
        !peer ||
        !peer.identityPinnedAt ||
        !peer.localServiceAvailable ||
        peer.trustLevel === 'halted'
      )
        return;
      const now = new Date();
      const trustLevel = this.lifecycle({
        ...peer,
        remoteServiceReachable: true,
      });
      restored = this.didRecover(peer, trustLevel);
      await tx
        .update(tables.identityNamespace)
        .set({
          remoteServiceReachable: true,
          lastSuccessAt: now,
          degradedAt: null,
          degradationReason: null,
          trustLevel,
          trustedAt:
            trustLevel === 'available'
              ? (peer.trustedAt ?? now)
              : peer.trustedAt,
        })
        .where(
          and(
            eq(tables.identityNamespace.domain, normalized),
            eq(tables.identityNamespace.active, true),
          ),
        );
    });
    if (restored) {
      this.logger.log(`Contact ${normalized}: degraded → available`);
      this.emitPeerAvailable(normalized);
    }
  }

  async markTransportDegraded(
    domain: string,
    reason: string,
    operationStartedAt?: Date,
  ): Promise<void> {
    const normalized = this.normalizeDomain(domain);
    await this.database.db.transaction(async (tx) => {
      const peer = await this.lockPeer(tx, normalized);
      if (
        !peer ||
        peer.trustLevel === 'halted' ||
        (operationStartedAt !== undefined &&
          peer.lastSuccessAt !== null &&
          peer.lastSuccessAt > operationStartedAt)
      )
        return;
      const transitioned = peer.trustLevel === 'available';
      await tx
        .update(tables.identityNamespace)
        .set({
          trustLevel: this.lifecycle({
            ...peer,
            remoteServiceReachable: false,
          }),
          remoteServiceReachable: false,
          ...(transitioned
            ? {
                degradationCount: sql`${tables.identityNamespace.degradationCount} + 1`,
              }
            : {}),
          degradedAt: new Date(),
          degradationReason: reason.slice(0, 255),
        })
        .where(
          and(
            eq(tables.identityNamespace.domain, normalized),
            eq(tables.identityNamespace.active, true),
          ),
        );
    });
  }

  private didRecover(
    peer:
      | Pick<typeof tables.identityNamespace.$inferSelect, 'trustLevel'>
      | undefined,
    trustLevel: string,
  ): boolean {
    return peer?.trustLevel === 'degraded' && trustLevel === 'available';
  }

  private async runRecognize(domain: string): Promise<OutboundRecognizeResult> {
    this.publishProgress(domain, 'DISCOVERING');
    await this.discovery.resolveBase(domain);
    this.publishProgress(domain, 'VERIFYING_IDENTITY');
    const doc = await this.discovery.fetchWellKnown(domain);
    // Outbound first pin: the root authorizing the peer's currently valid
    // certificates. A B-mode rotation leaves exactly one such root; several
    // means the peer serves overlap and the claim of the certificate that
    // answers our request resolves the epoch on their side.
    const certifyingRoots = currentCertifyingRoots(doc);
    if (certifyingRoots.length !== 1) {
      throw new Error(
        `Recognize ${domain}: well-known group does not resolve to exactly one certifying root`,
      );
    }
    const context = await this.prepareOutbound(domain, certifyingRoots[0]!);
    await this.discovery.cacheDocument(domain, context.namespaceId, doc);
    const base = await this.discovery.resolveBase(domain);
    const url = new URL(`${base}/s2s/v1/recognize`);
    const body = context.namespaceId
      ? JSON.stringify({ namespaceId: context.namespaceId })
      : '{}';
    const release = await this.discovery.acquireRequestSlot(domain);
    try {
      const headers = await this.signature.signOutbound({
        method: 'POST',
        url,
        body,
      });
      let response: Response;
      this.publishProgress(domain, 'CONNECTING');
      try {
        response = await this.discovery.request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body,
          signal: AbortSignal.timeout(
            this.transportConfig.get().callTimeoutSec * 1000,
          ),
        });
      } catch (error) {
        await this.markTransportDegraded(
          domain,
          `Recognize network/timeout: ${(error as Error).message}`,
        );
        throw error;
      }
      if (response.status !== 200)
        await this.handleRecognizeHttpFailure(domain, response);
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        value = undefined;
      }
      const result = this.parseRecognizeResult(value);
      if (!result) {
        await this.markTransportDegraded(
          domain,
          'Recognize malformed recognized result',
        );
        throw new Error(
          `Recognize ${domain} returned malformed recognized result`,
        );
      }
      if (result.status === 'failed') {
        throw new BusinessException(
          result.code,
          result.message,
          HttpStatus.CONFLICT,
        );
      }
      if (result.status === 'pending') {
        return { domain, status: 'pending', message: result.message };
      }
      await this.recordPeerAssignedLocalNamespace(
        domain,
        result.peerAssignedLocalNamespaceId,
      );
      let becameAvailable = false;
      await this.database.db.transaction(async (tx) => {
        const peer = await this.lockPeer(tx, domain);
        if (!peer) return;
        const now = new Date();
        const next = {
          ...peer,
          peerAcceptanceConfirmed: true,
          remoteServiceReachable: true,
        };
        const trustLevel = this.lifecycle(next);
        becameAvailable =
          peer.trustLevel !== 'available' && trustLevel === 'available';
        await tx
          .update(tables.identityNamespace)
          .set({
            peerAcceptanceConfirmed: true,
            remoteServiceReachable: true,
            lastSuccessAt: now,
            degradedAt: null,
            degradationReason: null,
            trustLevel,
            trustedAt:
              trustLevel === 'available'
                ? (peer.trustedAt ?? now)
                : peer.trustedAt,
          })
          .where(
            and(
              eq(tables.identityNamespace.domain, domain),
              eq(tables.identityNamespace.active, true),
            ),
          );
      });
      if (becameAvailable) this.emitPeerAvailable(domain);
      return { domain, status: 'recognized' };
    } finally {
      release();
    }
  }

  private async prepareOutbound(
    domain: string,
    rootPublicKey: string,
  ): Promise<VerifiedFederationNamespace> {
    const mismatch = await this.database.db.transaction(async (tx) => {
      const peer = await this.lockPeer(tx, domain);
      this.assertPolicyAllowsRecognition(peer, domain);
      if (peer?.identityPinnedAt && peer.rootPublicKey !== rootPublicKey) {
        await this.markIdentityLostInTx(tx, domain);
        return { mismatch: true as const };
      }
      const now = new Date();
      const next = {
        ...peer,
        identityPinnedAt: peer?.identityPinnedAt ?? now,
        localServiceAvailable: true,
      };
      const trustLevel = this.lifecycle(next);
      const context = await this.namespaces.activateVerifiedInTx(tx, {
        domain,
        rootPublicKey,
        identityPinnedAt: peer?.identityPinnedAt ?? now,
      });
      await tx
        .update(tables.identityNamespace)
        .set({
          localServiceAvailable: true,
          trustLevel,
          trustedAt:
            trustLevel === 'available'
              ? (peer?.trustedAt ?? now)
              : peer?.trustedAt,
        })
        .where(eq(tables.identityNamespace.id, context.namespaceId));
      return { mismatch: false as const, context };
    });
    if (mismatch.mismatch) this.throwIdentityMismatch(domain);
    return mismatch.context;
  }

  private async recordPeerAssignedLocalNamespace(
    domain: string,
    peerAssignedLocalNamespaceId: number,
  ): Promise<void> {
    await this.database.db.transaction((tx) =>
      this.namespaces.recordPeerAssignedLocalNamespaceInTx(
        tx,
        domain,
        peerAssignedLocalNamespaceId,
      ),
    );
  }

  private async lockPeer(tx: DatabaseTransaction, domain: string) {
    const [peer] = await tx
      .select(getTableColumns(tables.identityNamespace))
      .from(tables.identityNamespace)
      .where(
        and(
          eq(tables.identityNamespace.domain, domain),
          eq(tables.identityNamespace.active, true),
        ),
      )
      .for('no key update', { of: tables.identityNamespace })
      .limit(1);
    return peer;
  }

  private assertPolicyAllowsRecognition(
    peer: Awaited<ReturnType<FederationRecognitionService['lockPeer']>>,
    domain: string,
  ): void {
    if (peer?.trustLevel === 'halted') {
      const code = this.isFatalCode(peer.haltCode)
        ? peer.haltCode
        : BusinessCode.FEDERATION_IDENTITY_MISMATCH;
      throw new BusinessException(
        code,
        `${domain} federation relationship is halted`,
        HttpStatus.CONFLICT,
      );
    }
  }

  private async markIdentityLostInTx(
    tx: DatabaseTransaction,
    domain: string,
  ): Promise<void> {
    const reason = 'peer presented a root different from the pinned identity';
    await tx
      .update(tables.identityNamespace)
      .set({
        trustLevel: 'halted',
        remoteServiceReachable: false,
        haltedAt: new Date(),
        haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        haltReason: reason,
      })
      .where(
        and(
          eq(tables.identityNamespace.domain, domain),
          eq(tables.identityNamespace.active, true),
        ),
      );
  }

  private lifecycle(
    peer: Partial<typeof tables.identityNamespace.$inferSelect> & {
      identityPinnedAt?: Date | null;
    },
  ): string {
    if (peer.trustLevel === 'halted') {
      return 'halted';
    }
    if (!peer.identityPinnedAt) return 'unrecognized';
    if (!peer.localServiceAvailable) return 'unrecognized';
    if (!peer.peerAcceptanceConfirmed) return 'establishing';
    return peer.remoteServiceReachable ? 'available' : 'degraded';
  }

  private emitPeerAvailable(domain: string): void {
    this.events.emit(FEDERATION_PEER_AVAILABLE, {
      peerDomain: domain,
    } satisfies FederationPeerAvailable);
  }

  private async handleRecognizeHttpFailure(
    domain: string,
    response: Response,
  ): Promise<never> {
    const body = parsePeerErrorBody(
      await response.json().catch(() => undefined),
    );
    if (body.code === undefined) {
      // The protocol requires `code` on every non-2xx body; warn so a peer
      // serving HTML error pages or junk stays diagnosable.
      this.logger.warn(
        `Recognize ${domain} returned HTTP ${response.status} without a numeric code in its error body`,
      );
    }
    const message =
      body.message ?? `Recognize ${domain} returned HTTP ${response.status}`;
    if (
      response.status === HttpStatus.CONFLICT &&
      this.isFatalCode(body.code)
    ) {
      await this.markHalted(domain, body.code, message);
      throw new BusinessException(body.code, message, HttpStatus.CONFLICT);
    }
    if (response.status === HttpStatus.SERVICE_UNAVAILABLE) {
      await this.markTransportDegraded(
        domain,
        `Recognize HTTP 503: ${message}`,
      );
    }
    throw new Error(`Recognize ${domain} returned HTTP ${response.status}`);
  }

  private async markHalted(
    domain: string,
    code: number,
    reason: string,
  ): Promise<void> {
    await this.database.db
      .update(tables.identityNamespace)
      .set({
        trustLevel: 'halted',
        remoteServiceReachable: false,
        haltedAt: new Date(),
        haltCode: code,
        haltReason: reason.slice(0, 255),
      })
      .where(
        and(
          eq(tables.identityNamespace.domain, domain),
          eq(tables.identityNamespace.active, true),
        ),
      );
  }

  private isFatalCode(code: unknown): code is number {
    return [
      BusinessCode.FEDERATION_PEER_BLOCKED,
      BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      BusinessCode.FEDERATION_PROTOCOL_VERSION_UNSUPPORTED,
    ].includes(code as BusinessCode);
  }

  private toRecognizeFailure(error: unknown): RecognizeFailed {
    if (error instanceof BusinessException) {
      const code = error.bizCode;
      return {
        ok: false,
        status: 'failed',
        code,
        message: error.message || 'recognition failed',
      };
    }
    return {
      ok: false,
      status: 'failed',
      code: BusinessCode.INTERNAL,
      message: (error as Error).message || 'recognition failed',
    };
  }

  /** Closed-shape parse of a Recognize result body: unknown fields are
   * rejected, and `message` is required on `failed` exactly like the outbound
   * failures this server itself serializes. */
  private parseRecognizeResult(value: unknown): RecognizeResult | null {
    if (!this.isRecord(value)) return null;
    const { ok, status } = value;
    if (ok === true && status === 'recognized') {
      if (Object.keys(value).length !== 3) return null;
      if (!this.isPositiveSafeInteger(value.peerAssignedLocalNamespaceId))
        return null;
      return {
        ok: true,
        status: 'recognized',
        peerAssignedLocalNamespaceId: value.peerAssignedLocalNamespaceId,
      };
    }
    if (ok === true && status === 'pending') {
      const keys = Object.keys(value);
      if (
        keys.some(
          (key) => key !== 'ok' && key !== 'status' && key !== 'message',
        )
      )
        return null;
      const message = value.message;
      if (message !== undefined && typeof message !== 'string') return null;
      return message === undefined
        ? { ok: true, status: 'pending' }
        : { ok: true, status: 'pending', message };
    }
    if (ok === false && status === 'failed') {
      const keys = Object.keys(value);
      if (
        keys.some(
          (key) =>
            key !== 'ok' &&
            key !== 'status' &&
            key !== 'code' &&
            key !== 'message',
        )
      )
        return null;
      const { code, message } = value;
      if (typeof code !== 'number' || !Number.isSafeInteger(code)) return null;
      if (typeof message !== 'string') return null;
      return { ok: false, status: 'failed', code, message };
    }
    return null;
  }

  private parseHealthResult(value: unknown): HealthResult | null {
    if (!this.isRecord(value)) return null;
    if (value.status === 'unavailable') {
      return Object.keys(value).length === 1 ? { status: 'unavailable' } : null;
    }
    if (value.status !== 'available' && value.status !== 'degraded')
      return null;
    if (Object.keys(value).length !== 2) return null;
    if (!this.isPositiveSafeInteger(value.peerAssignedLocalNamespaceId))
      return null;
    return {
      status: value.status,
      peerAssignedLocalNamespaceId: value.peerAssignedLocalNamespaceId,
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private isPositiveSafeInteger(value: unknown): value is number {
    return (
      Number.isSafeInteger(value) && typeof value === 'number' && value > 0
    );
  }

  private normalizeDomain(value: string): string {
    return value.trim().toLowerCase().replace(/\.+$/, '');
  }

  private throwIdentityMismatch(domain: string): never {
    throw new BusinessException(
      BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      `${domain} root identity does not match the pin`,
      HttpStatus.CONFLICT,
    );
  }
}
