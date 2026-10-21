import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { normalizeClientAddress } from '../rate-limit/client-address.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import * as tables from '../database/schema.js';
import {
  currentCertifyingRoots,
  DiscoveryService,
  type WellKnownDoc,
} from './discovery.service.js';
import {
  parsePeerErrorBody,
  parseStrictPeerErrorEnvelope,
} from './federation-errors.js';
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

type RecognizeError = {
  code: number;
  message: string;
};

type RecognizeResult =
  | {
      status: 'pending';
      message?: string;
    }
  | {
      status: 'recognized';
      peerAssignedLocalNamespaceId: number;
    }
  | RecognizeError;

export type OutboundRecognizeResult =
  | { domain: string; status: 'pending'; message?: string }
  | { domain: string; status: 'recognized' };

export type FederationRecognitionStage =
  | 'DISCOVERING'
  | 'VERIFYING_IDENTITY'
  | 'CONNECTING';

const INBOUND_REFUSAL_COOLDOWN_MS = 10 * 60_000;
const INBOUND_IP_COOLDOWN_MS = 10 * 60_000;
const INBOUND_CACHE_LIMIT = 4096;
const INBOUND_CLEANUP_INTERVAL_MS = 60_000;

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

  /** Signature failures belong to exact request evidence, not a claimed
   * identity. Both caches are bounded FIFO maps; reads do not refresh age. */
  private readonly inboundRecognizeRefusals = new Map<
    string,
    { code: BusinessCode; message: string; expiresAt: number }
  >();
  private readonly inboundRecognizeIps = new Map<string, number>();
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
    requestIp: string;
    domain: string;
    keyId: string;
    claimedRoot: string;
    signedRequest: SignedRequest;
    headers: OutboundSignatureHeaders;
    senderAssignedLocalNamespaceId?: number;
    signatureExpires: number;
  }): Promise<RecognizeResult> {
    const domain = this.normalizeDomain(params.domain);
    // Recognition is deliberately database-authoritative. The in-flight map
    // coalesces expensive verification, while the committed namespace row is
    // the source of truth for a later request.
    // (1) A recognized epoch for exactly this (domain, root) answers from its
    // committed state; no open review or cooldown may mask it.
    const recognized = await this.readRecognizedInbound(
      domain,
      params.claimedRoot,
    );
    if (recognized) return recognized;
    // (1') A durably halted epoch for this exact identity answers the fatal
    // conflict synchronously (category 4).
    await this.assertInboundNotHalted(domain, params.claimedRoot);
    // (2) A claimed root held only by retired epochs identifies an identity
    // this server already archived. Retirement is terminal for that
    // identity: a later arrival must be refused outright, never re-admitted
    // silently as a first recognition. Only a genuinely new root may start a
    // fresh epoch at the same domain.
    await this.assertInboundIdentityNotRetired(params.claimedRoot);
    // (2') A persisted verified conclusion for exactly this tuple answers
    // immediately: identity mismatch throws the fatal 409, a domain
    // conflict returns the cooled refusal. Records whose namespace
    // snapshot went stale (admin recovery moved the binding) inert
    // themselves and the arrival falls through to re-verification.
    const verifiedConflict = await this.answerVerifiedConflict(
      domain,
      params.claimedRoot,
    );
    if (verifiedConflict) return verifiedConflict;
    // (3) An administrator review bound to exactly this proposal answers
    // with its current status. The candidate proposal is derived here from
    // live state — the arrival proves nothing yet — through the same
    // resolver the background verifier uses, so a review for one new root
    // never masks another root's arrival, and a rejected review is served
    // only to the exact proposal (same origin pin) that was refused.
    const identity = await this.resolveArrivalIdentity(
      domain,
      params.claimedRoot,
    );
    if (identity.proposal) {
      const review = await this.findReviewForProposal(
        identity.proposal,
        domain,
        params.claimedRoot,
      );
      if (review?.status === 'pending') {
        return {
          status: 'pending',
          message: 'waiting for administrator approval',
        };
      }
      if (review?.status === 'rejected') {
        return {
          code:
            review.kind === 'domain-rebind'
              ? BusinessCode.FEDERATION_DOMAIN_CHANGE_REJECTED
              : BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
          message:
            review.kind === 'domain-rebind'
              ? 'domain re-binding rejected by administrator review'
              : review.kind === 'identity-reset'
                ? 'identity reset rejected by administrator review'
                : 'root rotation rejected by administrator review',
        };
      }
    }

    this.cleanupInboundRecognizeCaches();
    // Hash all verification inputs, including signature bytes and body. A
    // forged signature must never refuse a different request for the same
    // root/keyId. Canonical header ordering avoids insertion-order misses.
    const evidenceKey = createHash('sha256')
      .update(
        JSON.stringify([
          domain,
          params.claimedRoot,
          params.keyId,
          params.signedRequest.method,
          params.signedRequest.url.href,
          params.signedRequest.body,
          Object.entries(params.headers).sort(([a], [b]) => a.localeCompare(b)),
          params.senderAssignedLocalNamespaceId ?? null,
          params.signatureExpires,
        ]),
      )
      .digest('hex');
    const refusal = this.inboundRecognizeRefusals.get(evidenceKey);
    if (refusal) return { code: refusal.code, message: refusal.message };

    // No await between checking and reserving a slot: concurrent requests
    // from one IP cannot start multiple verifiers. Fastify's trusted-proxy
    // policy owns address resolution; never parse forwarding headers here.
    const now = Date.now();
    const ip = normalizeClientAddress(params.requestIp)?.exactSubject;
    if (
      ip &&
      !this.inboundRecognizeInFlight.has(evidenceKey) &&
      !this.inboundRecognizeIps.has(ip) &&
      this.inboundRecognizeInFlight.size < INBOUND_CACHE_LIMIT
    ) {
      this.insertInboundCache(
        this.inboundRecognizeIps,
        ip,
        now + INBOUND_IP_COOLDOWN_MS,
      );
      const run = this.verifyInboundRecognize({ ...params, domain });
      this.inboundRecognizeInFlight.set(evidenceKey, run);
      void run
        .then(
          () => {
            if (this.inboundRecognizeInFlight.get(evidenceKey) !== run) return;
            this.inboundRecognizeRefusals.delete(evidenceKey);
          },
          (error: unknown) => {
            if (this.inboundRecognizeInFlight.get(evidenceKey) !== run) return;
            const failure = this.toRecognizeFailure(error);
            this.logger.warn(
              `Recognize ${domain} verification failed: ${failure.message}`,
            );
            // Domain conflicts are served from verified persistent state, not
            // a second process-local cache that could outlive that binding.
            if (
              error instanceof BusinessException &&
              error.bizCode === BusinessCode.FEDERATION_BAD_SIGNATURE
            ) {
              this.insertInboundCache(
                this.inboundRecognizeRefusals,
                evidenceKey,
                {
                  code: error.bizCode,
                  message: error.message,
                  expiresAt: Date.now() + INBOUND_REFUSAL_COOLDOWN_MS,
                },
              );
            }
          },
        )
        .finally(() => {
          if (this.inboundRecognizeInFlight.get(evidenceKey) === run)
            this.inboundRecognizeInFlight.delete(evidenceKey);
        });
    }
    return {
      status: 'pending',
      message: 'verification in progress',
    };
  }

  /** Independent expiry sweep also releases one-off keys never read again. */
  @Interval(INBOUND_CLEANUP_INTERVAL_MS)
  cleanupInboundRecognizeCaches(): void {
    const now = Date.now();
    for (const [key, value] of this.inboundRecognizeRefusals)
      if (value.expiresAt <= now) this.inboundRecognizeRefusals.delete(key);
    for (const [ip, expiresAt] of this.inboundRecognizeIps)
      if (expiresAt <= now) this.inboundRecognizeIps.delete(ip);
  }

  private insertInboundCache<T>(
    cache: Map<string, T>,
    key: string,
    value: T,
  ): void {
    this.cleanupInboundRecognizeCaches();
    cache.delete(key);
    if (cache.size >= INBOUND_CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, value);
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
    // --- Root-identity resolution (recognition 4.4), shared with the
    // synchronous answer path so review matching and review recording
    // cannot drift apart. ---
    const { domainEpoch, rootEpoch } = await this.resolveArrivalIdentity(
      normalized,
      claimedRoot,
    );

    const requireCoordinateMatch = async (epoch: {
      id: number;
      domain: string;
      rootPublicKey?: string | null;
      peerAssignedLocalNamespaceId: number | null;
    }): Promise<void> => {
      if (
        params.senderAssignedLocalNamespaceId !== undefined &&
        epoch.peerAssignedLocalNamespaceId !== null &&
        params.senderAssignedLocalNamespaceId !==
          epoch.peerAssignedLocalNamespaceId
      ) {
        const reason = `${normalized} sender-assigned local namespace does not match pinned identity`;
        await this.database.db.transaction(async (tx) => {
          const peer = await this.lockPeer(tx, epoch.domain);
          if (
            !peer ||
            peer.id !== epoch.id ||
            !peer.rootPublicKey ||
            peer.rootPublicKey !== (epoch.rootPublicKey ?? claimedRoot)
          )
            return;
          await this.markIdentityLostInTx(tx, epoch.domain);
          await this.recordVerifiedConflictInTx(tx, {
            domain: normalized,
            claimedRoot,
            namespaceId: peer.id,
            namespaceDomain: peer.domain,
            namespaceRoot: peer.rootPublicKey,
            code: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
            reason,
          });
        });
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          reason,
          HttpStatus.CONFLICT,
        );
      }
    };

    if (rootEpoch && rootEpoch.domain === normalized) {
      // Claimed root already pinned and bound to this domain: ordinary
      // idempotent re-recognition; commit acceptance directly.
      await requireCoordinateMatch(rootEpoch);
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
        const message = `${normalized} is already bound to another peer identity`;
        // The signature already verified under the claimed root, so this is
        // a fact about the verified tuple, not about one request: persist it
        // so later arrivals of the same tuple are answered from state.
        await this.recordVerifiedConflict({
          domain: normalized,
          claimedRoot,
          namespaceId: domainEpoch.id,
          namespaceDomain: domainEpoch.domain,
          namespaceRoot: domainEpoch.rootPublicKey ?? '',
          code: BusinessCode.FEDERATION_DOMAIN_CONFLICT,
          reason: message,
        });
        throw new BusinessException(
          BusinessCode.FEDERATION_DOMAIN_CONFLICT,
          message,
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
      await requireCoordinateMatch(domainEpoch);
      const pinEntry = doc.roots.find(
        (entry) => entry.ed25519 === domainEpoch.rootPublicKey,
      );
      const pinStillValid =
        pinEntry !== undefined &&
        pinEntry.notBefore <= now &&
        now < pinEntry.notAfter;
      if (!pinStillValid) {
        // The verified document dropped the pinned predecessor: the arrival
        // claims a successor with no provable continuity. The epoch halts
        // (its pin no longer authorizes anything published), but instead of
        // an invisible dead end the arrival opens an identity-reset review:
        // pending then truthfully means "awaiting administrator decision",
        // and the reviewer either adopts the arrival as a brand-new peer
        // (retire + fresh recognition) or replaces this namespace's
        // identity under explicit responsibility.
        const message = `${normalized} no longer publishes the pinned root in its group`;
        await this.recordIdentityReset({
          matchedNamespaceId: domainEpoch.id,
          nextDomain: normalized,
          claimedRoot,
          haltReason: message,
          claim: {
            previousRoot: domainEpoch.rootPublicKey,
            claimedRoot,
            rootGroup: doc.roots,
            senderAssignedLocalNamespaceId:
              params.senderAssignedLocalNamespaceId ?? null,
            arrivedAt: new Date().toISOString(),
          },
        });
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

  /** An arrival claiming an identity whose only epochs are retired is a
   *  retired relationship knocking again. Answer the terminal refusal
   *  synchronously: no re-verification, no fresh epoch for that root. */
  private async assertInboundIdentityNotRetired(
    claimedRoot: string,
  ): Promise<void> {
    const retired = await this.database.db.query.identityNamespace.findFirst({
      where: and(
        eq(tables.identityNamespace.rootPublicKey, claimedRoot),
        isNotNull(tables.identityNamespace.retiredAt),
        sql`${tables.identityNamespace.id} > 0`,
      ),
      columns: { id: true },
    });
    if (retired) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_BLOCKED,
        'the claimed identity belongs to a retired federation epoch',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Recognize result category 4 (irrecoverable): a relationship durably
   *  halted for this claimed identity answers the fatal conflict from
   *  persisted state, synchronously and immediately. */
  private async assertInboundNotHalted(
    domain: string,
    claimedRoot: string,
  ): Promise<void> {
    const peer = await this.database.db.query.identityNamespace.findFirst({
      where: and(
        eq(tables.identityNamespace.domain, domain),
        eq(tables.identityNamespace.rootPublicKey, claimedRoot),
        isNull(tables.identityNamespace.retiredAt),
        sql`${tables.identityNamespace.id} > 0`,
        eq(tables.identityNamespace.trustLevel, 'halted'),
      ),
      columns: { haltCode: true },
    });
    if (!peer) return;
    const code = [
      BusinessCode.FEDERATION_PEER_BLOCKED,
      BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      BusinessCode.FEDERATION_PROTOCOL_VERSION_UNSUPPORTED,
    ].includes(peer.haltCode as BusinessCode)
      ? peer.haltCode!
      : BusinessCode.FEDERATION_IDENTITY_MISMATCH;
    throw new BusinessException(
      code,
      `${domain} federation relationship is halted`,
      HttpStatus.CONFLICT,
    );
  }

  /** Persist one verified terminal conclusion for an arrival tuple.
   *  Callers must only invoke this after the request's signature verified
   *  under the fetched, hostname-verified document — the record is served to
   *  later arrivals without re-verification, so it must encode facts, not
   *  claims. The snapshot columns let serving-time liveness checks inert the
   *  row once the namespace binding moves on (retirement, re-binding,
   *  recovery) without deleting audit history. */
  private async recordVerifiedConflict(params: {
    domain: string;
    claimedRoot: string;
    namespaceId: number;
    namespaceDomain: string;
    namespaceRoot: string;
    code: number;
    reason: string;
  }): Promise<void> {
    await this.database.db.transaction((tx) =>
      this.recordVerifiedConflictInTx(tx, params),
    );
  }

  private async recordVerifiedConflictInTx(
    tx: DatabaseTransaction,
    params: {
      domain: string;
      claimedRoot: string;
      namespaceId: number;
      namespaceDomain: string;
      namespaceRoot: string;
      code: number;
      reason: string;
    },
  ): Promise<void> {
    const now = new Date();
    await tx
      .insert(tables.federationIdentityConflict)
      .values({
        domain: params.domain,
        rootPublicKey: params.claimedRoot,
        namespaceId: params.namespaceId,
        namespaceDomain: params.namespaceDomain,
        namespaceRoot: params.namespaceRoot,
        code: params.code,
        reason: params.reason.slice(0, 255),
        verifiedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          tables.federationIdentityConflict.domain,
          tables.federationIdentityConflict.rootPublicKey,
        ],
        set: {
          namespaceId: params.namespaceId,
          namespaceDomain: params.namespaceDomain,
          namespaceRoot: params.namespaceRoot,
          code: params.code,
          reason: params.reason.slice(0, 255),
          verifiedAt: now,
        },
      });
  }

  /** Serve a persisted verified conclusion to a later arrival of the same
   *  tuple. Liveness: the referenced namespace must still be the active,
   *  unretired epoch with exactly the snapshotted binding, and identity
   *  mismatch rows must still be halted — any admin recovery (retire,
   *  recover, re-bind) inerts the record and the arrival re-verifies. */
  private async answerVerifiedConflict(
    domain: string,
    claimedRoot: string,
  ): Promise<Extract<RecognizeResult, { code: number }> | null> {
    const rows = await this.database.db
      .select({
        code: tables.federationIdentityConflict.code,
        reason: tables.federationIdentityConflict.reason,
      })
      .from(tables.federationIdentityConflict)
      .innerJoin(
        tables.identityNamespace,
        eq(
          tables.identityNamespace.id,
          tables.federationIdentityConflict.namespaceId,
        ),
      )
      .where(
        and(
          eq(tables.federationIdentityConflict.domain, domain),
          eq(tables.federationIdentityConflict.rootPublicKey, claimedRoot),
          eq(tables.identityNamespace.active, true),
          isNull(tables.identityNamespace.retiredAt),
          eq(
            tables.identityNamespace.domain,
            tables.federationIdentityConflict.namespaceDomain,
          ),
          eq(
            tables.identityNamespace.rootPublicKey,
            tables.federationIdentityConflict.namespaceRoot,
          ),
          sql`( ${tables.federationIdentityConflict.code} <> ${BusinessCode.FEDERATION_IDENTITY_MISMATCH} OR ${tables.identityNamespace.trustLevel} = 'halted' )`,
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.code === BusinessCode.FEDERATION_IDENTITY_MISMATCH) {
      // Category 4: the fatal conflict is durably established for this
      // verified tuple; answer it synchronously instead of looping through
      // background re-verification that could never reach the sender.
      throw new BusinessException(row.code, row.reason, HttpStatus.CONFLICT);
    }
    return { code: row.code, message: row.reason };
  }

  private async readRecognizedInbound(
    domain: string,
    claimedRoot: string,
  ): Promise<Extract<RecognizeResult, { status: 'recognized' }> | null> {
    const peer = await this.database.db.query.identityNamespace.findFirst({
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
          status: 'recognized',
          // Tell the sender how this receiver numbers it, not the reverse coordinate.
          peerAssignedLocalNamespaceId: peer.id,
        };
  }

  /** Shared root-identity resolution for the synchronous answer path and
   *  the background verifier: which unretired epochs the arrival's
   *  (domain, root) tuple touches, and which proposal — if any — the arrival
   *  represents. Both call sites must derive identical candidates, or the
   *  review a later arrival matches and the review the verifier records
   *  drift apart. */
  async resolveArrivalIdentity(
    domain: string,
    claimedRoot: string,
  ): Promise<{
    domainEpoch: {
      id: number;
      domain: string;
      rootPublicKey: string | null;
      peerAssignedLocalNamespaceId: number | null;
    } | null;
    rootEpoch: {
      id: number;
      domain: string;
      peerAssignedLocalNamespaceId: number | null;
    } | null;
    proposal: {
      kind: 'domain-rebind' | 'root-rotation';
      matchedNamespaceId: number;
      previousPin: string;
    } | null;
  }> {
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
          eq(tables.identityNamespace.domain, domain),
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
    let proposal: {
      kind: 'domain-rebind' | 'root-rotation';
      matchedNamespaceId: number;
      previousPin: string;
    } | null = null;
    if (rootEpoch && rootEpoch.domain !== domain) {
      // Root pinned under another domain: a re-binding arrival proposing to
      // move the existing relationship. The origin pin is where the root is
      // pinned now.
      proposal = {
        kind: 'domain-rebind',
        matchedNamespaceId: rootEpoch.id,
        previousPin: rootEpoch.domain,
      };
    } else if (!rootEpoch && domainEpoch) {
      // Root not pinned anywhere while this domain has an epoch: a rotation
      // arrival. The origin pin is the domain epoch's current root.
      proposal = {
        kind: 'root-rotation',
        matchedNamespaceId: domainEpoch.id,
        previousPin: domainEpoch.rootPublicKey ?? '',
      };
    }
    return {
      domainEpoch: domainEpoch ?? null,
      rootEpoch: rootEpoch ?? null,
      proposal,
    };
  }

  /** Find the review answering one exact proposal. The stored columns bind
   *  the result to this proposal; the claim's origin pin (previousRoot for
   *  rotations, previousDomain for re-binds) must equal the live pin, so a
   *  review recorded before an intervening epoch change is never served to
   *  a newer proposal that happens to reuse the same domain and root. */
  private async findReviewForProposal(
    proposal: {
      kind: 'domain-rebind' | 'root-rotation';
      matchedNamespaceId: number;
      previousPin: string;
    },
    domain: string,
    claimedRoot: string,
  ) {
    const rows = await this.database.db
      .select({
        id: tables.federationIdentityReview.id,
        kind: tables.federationIdentityReview.kind,
        status: tables.federationIdentityReview.status,
        claim: tables.federationIdentityReview.claim,
      })
      .from(tables.federationIdentityReview)
      .where(
        and(
          proposal.kind === 'domain-rebind'
            ? eq(tables.federationIdentityReview.kind, 'domain-rebind')
            : inArray(tables.federationIdentityReview.kind, [
                'root-rotation',
                'identity-reset',
              ]),
          eq(
            tables.federationIdentityReview.matchedNamespaceId,
            proposal.matchedNamespaceId,
          ),
          eq(tables.federationIdentityReview.nextDomain, domain),
          eq(tables.federationIdentityReview.claimedRoot, claimedRoot),
          sql`${tables.federationIdentityReview.claim} ->> ${proposal.kind === 'domain-rebind' ? 'previousDomain' : 'previousRoot'} = ${proposal.previousPin}`,
          inArray(tables.federationIdentityReview.status, [
            'pending',
            'rejected',
          ]),
        ),
      )
      .orderBy(desc(tables.federationIdentityReview.updatedAt))
      .limit(1);
    const originKey =
      proposal.kind === 'root-rotation' ? 'previousRoot' : 'previousDomain';
    return rows.find(
      (row) =>
        (row.claim?.[originKey] as string | undefined) === proposal.previousPin,
    );
  }

  /** Idempotently record one review fact for a matched namespace; a repeated
   *  coherent arrival refreshes the claim snapshot of the open review. */
  private async recordReview(params: {
    kind: 'domain-rebind' | 'root-rotation' | 'identity-reset';
    matchedNamespaceId: number;
    nextDomain: string;
    claimedRoot: string;
    claim: Record<string, unknown>;
  }): Promise<void> {
    await this.database.db.transaction((tx) =>
      this.upsertReviewInTx(tx, params),
    );
  }

  /** Idempotently record one review fact for a matched namespace; a repeated
   *  coherent arrival refreshes the claim snapshot (and kind) of the open
   *  review. */
  private async upsertReviewInTx(
    tx: DatabaseTransaction,
    params: {
      kind: 'domain-rebind' | 'root-rotation' | 'identity-reset';
      matchedNamespaceId: number;
      nextDomain: string;
      claimedRoot: string;
      claim: Record<string, unknown>;
    },
  ): Promise<void> {
    const now = new Date();
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
          kind: params.kind,
          nextDomain: params.nextDomain,
          claimedRoot: params.claimedRoot,
          claim: params.claim,
          verifiedAt: now,
          updatedAt: now,
        },
      });
    // A pending review authorizes no new binding. Keep the existing peer's
    // acceptance and admission unchanged until the binding is approved;
    // neither root rotation nor domain re-binding creates a new peer.
  }

  /** Halt an epoch whose pinned predecessor was dropped from the verified
   *  root group, and in the same transaction open an identity-reset review
   *  for the arrival that proved it. Atomicity matters: a halt without its
   *  review would silently strand later arrivals, a review without the halt
   *  would keep authorizing a pin the peer no longer publishes. */
  private async recordIdentityReset(params: {
    matchedNamespaceId: number;
    nextDomain: string;
    claimedRoot: string;
    haltReason: string;
    claim: Record<string, unknown>;
  }): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const peer = await this.lockPeer(tx, params.nextDomain);
      if (
        !peer ||
        peer.id !== params.matchedNamespaceId ||
        peer.retiredAt ||
        peer.rootPublicKey !== params.claim.previousRoot ||
        (peer.trustLevel === 'halted' &&
          peer.haltCode !== BusinessCode.FEDERATION_IDENTITY_MISMATCH)
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          'binding changed during identity verification',
          HttpStatus.CONFLICT,
        );
      }
      await tx
        .update(tables.identityNamespace)
        .set({
          trustLevel: 'halted',
          remoteServiceReachable: false,
          haltedAt: new Date(),
          haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          haltReason: params.haltReason,
        })
        .where(eq(tables.identityNamespace.id, params.matchedNamespaceId));
      await this.upsertReviewInTx(tx, {
        kind: 'identity-reset',
        matchedNamespaceId: params.matchedNamespaceId,
        nextDomain: params.nextDomain,
        claimedRoot: params.claimedRoot,
        claim: params.claim,
      });
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
        await this.recordVerifiedConflictInTx(tx, {
          domain: normalized,
          claimedRoot: rootPublicKey,
          namespaceId: peer.id,
          namespaceDomain: peer.domain,
          namespaceRoot: peer.rootPublicKey!,
          code: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          reason: 'peer presented a root different from the pinned identity',
        });
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
    const context = await this.prepareOutbound(domain, doc);
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
      if ('code' in result) {
        // A non-zero HTTP 200 result rejects this operation; it is not remote
        // HTTP 409 evidence and must not be promoted into a peer hard stop.
        throw new BusinessException(result.code, result.message, HttpStatus.OK);
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
    doc: WellKnownDoc,
  ): Promise<VerifiedFederationNamespace> {
    const mismatch = await this.database.db.transaction(async (tx) => {
      const peer = await this.lockPeer(tx, domain);
      this.assertPolicyAllowsRecognition(peer, domain);
      let rootPublicKey: string;
      if (peer?.identityPinnedAt) {
        // Certificate cutover does not replace an existing identity pin. The
        // predecessor may remain published without any live certificates
        // while a successor awaits the inbound rotation review and challenge.
        const pinnedRoot = doc.roots.find(
          (entry) => entry.ed25519 === peer.rootPublicKey,
        );
        if (!pinnedRoot) {
          await this.markIdentityLostInTx(tx, domain);
          return { mismatch: true as const };
        }
        rootPublicKey = pinnedRoot.ed25519;
      } else {
        const certifyingRoots = currentCertifyingRoots(doc);
        if (certifyingRoots.length !== 1) {
          throw new Error(
            `Recognize ${domain}: well-known group does not resolve to exactly one certifying root`,
          );
        }
        rootPublicKey = certifyingRoots[0]!;
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
    const raw = await response.json().catch(() => undefined);
    const body = parsePeerErrorBody(raw);
    if (body.code === undefined) {
      // The protocol requires `code` on every non-2xx body; warn so a peer
      // serving HTML error pages or junk stays diagnosable.
      this.logger.warn(
        `Recognize ${domain} returned HTTP ${response.status} without a numeric code in its error body`,
      );
    }
    const message =
      body.message ?? `Recognize ${domain} returned HTTP ${response.status}`;
    // Only a strictly parsed closed envelope may drive the fatal decision.
    const strict = parseStrictPeerErrorEnvelope(raw);
    if (
      response.status === HttpStatus.CONFLICT &&
      strict &&
      this.isFatalCode(strict.code)
    ) {
      await this.markHalted(domain, strict.code, strict.message);
      throw new BusinessException(
        strict.code,
        strict.message,
        HttpStatus.CONFLICT,
      );
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

  private toRecognizeFailure(error: unknown): RecognizeError {
    if (error instanceof BusinessException) {
      const code = error.bizCode;
      return {
        code,
        message: error.message || 'recognition failed',
      };
    }
    return {
      code: BusinessCode.INTERNAL,
      message: (error as Error).message || 'recognition failed',
    };
  }

  /** Recognize uses the common closed envelope; only recognized data carries
   * acceptance evidence. The former bare result shapes are not accepted. */
  private parseRecognizeResult(value: unknown): RecognizeResult | null {
    if (!this.isRecord(value)) return null;
    if (
      Object.keys(value).some(
        (key) => !['code', 'message', 'data'].includes(key),
      )
    )
      return null;
    const { code, message, data } = value;
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) return null;
    if (typeof message !== 'string') return null;
    if (code !== 0) return { code, message };
    if (!this.isRecord(data)) return null;
    if (data.status === 'recognized') {
      if (Object.keys(data).length !== 2) return null;
      if (!this.isPositiveSafeInteger(data.peerAssignedLocalNamespaceId))
        return null;
      return {
        status: 'recognized',
        peerAssignedLocalNamespaceId: data.peerAssignedLocalNamespaceId,
      };
    }
    if (data.status === 'pending') {
      if (
        Object.keys(data).some((key) => key !== 'status' && key !== 'message')
      )
        return null;
      if (data.message !== undefined && typeof data.message !== 'string')
        return null;
      return data.message === undefined
        ? { status: 'pending' }
        : { status: 'pending', message: data.message };
    }
    return null;
  }

  private parseHealthResult(value: unknown): HealthResult | null {
    if (!this.isRecord(value)) return null;
    if (
      Object.keys(value).some(
        (key) => !['code', 'message', 'data'].includes(key),
      )
    )
      return null;
    if (value.code !== 0 || typeof value.message !== 'string') return null;
    const { data } = value;
    if (!this.isRecord(data)) return null;
    if (data.status === 'unavailable') {
      return Object.keys(data).length === 1 ? { status: 'unavailable' } : null;
    }
    if (data.status !== 'available' && data.status !== 'degraded') return null;
    if (Object.keys(data).length !== 2) return null;
    if (!this.isPositiveSafeInteger(data.peerAssignedLocalNamespaceId))
      return null;
    return {
      status: data.status,
      peerAssignedLocalNamespaceId: data.peerAssignedLocalNamespaceId,
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
