import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { DiscoveryService, type WellKnownDoc } from './discovery.service.js';
import { parsePeerErrorBody } from './federation-errors.js';
import {
  FEDERATION_PEER_AVAILABLE,
  type FederationPeerAvailable,
} from './federation-peer.events.js';
import { loadFederationConfig } from './federation.config.js';
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

interface RecognizeRecognized {
  ok: true;
  status: 'recognized';
  peerAssignedLocalNamespaceId: number;
}

export type FederationRecognitionStage =
  | 'DISCOVERING'
  | 'VERIFYING_IDENTITY'
  | 'CONNECTING';

@Injectable()
export class FederationRecognitionService {
  private readonly config = loadFederationConfig();
  private readonly logger = new Logger(FederationRecognitionService.name);
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly healthInFlight = new Map<
    string,
    Promise<FederationHealthStatus>
  >();
  private readonly inboundRecognizeInFlight = new Map<string, Promise<void>>();
  private readonly inboundRecognizeResults = new Map<
    string,
    { expiresAtMs: number; result: RecognizeResult }
  >();
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

  async recognize(peerDomain: string): Promise<void> {
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
        recognizesPeer: true,
        peerAcceptanceConfirmed: true,
        localServiceAvailable: true,
      },
    });
    // Health can confirm peer acceptance only after local identity preparation.
    if (!peer || !peer.recognizesPeer || !peer.localServiceAvailable) {
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
    signedRequest: SignedRequest;
    headers: OutboundSignatureHeaders;
    senderAssignedLocalNamespaceId?: number;
    signatureExpires: number;
  }): Promise<RecognizeResult> {
    const domain = this.normalizeDomain(params.domain);
    const cached = this.inboundRecognizeResults.get(domain);
    if (cached && cached.expiresAtMs > Date.now()) return cached.result;
    if (cached) this.inboundRecognizeResults.delete(domain);
    const candidate =
      await this.database.db.query.federationNamespaceCandidate.findFirst({
        where: eq(tables.federationNamespaceCandidate.nextDomain, domain),
      });
    if (candidate) {
      if (candidate.status === 'failed') {
        return {
          ok: false,
          status: 'failed',
          code:
            candidate.failedCode ??
            BusinessCode.FEDERATION_DOMAIN_CHANGE_REJECTED,
          message: candidate.failedMessage ?? 'recognition failed',
        };
      }
      return {
        ok: true,
        status: 'pending',
        message: 'waiting for administrator approval',
      };
    }
    const existing = this.inboundRecognizeInFlight.get(domain);
    if (!existing) {
      const run = this.verifyInboundRecognize({ ...params, domain }).finally(
        () => {
          if (this.inboundRecognizeInFlight.get(domain) === run) {
            this.inboundRecognizeInFlight.delete(domain);
          }
        },
      );
      this.inboundRecognizeInFlight.set(domain, run);
      void run.catch((error) => {
        const result = this.toRecognizeFailure(error);
        this.inboundRecognizeResults.set(domain, {
          expiresAtMs: params.signatureExpires * 1000,
          result,
        });
        this.logger.warn(
          `Recognize ${domain} verification failed: ${result.message}`,
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
      this.schedulePostHealthKeyRefresh(domain);
      return result.status;
    } finally {
      release();
    }
  }

  /** Outbound Health overlap refresh: after a successful round trip, pull the peer's
   *  published certificate set forward when its cached coverage is about to end. This is
   *  maintenance and must never turn the successful Health result into a failure. */
  private schedulePostHealthKeyRefresh(domain: string): void {
    void (async () => {
      try {
        const [peer] = await this.database.db
          .select({
            id: tables.identityNamespace.id,
          })
          .from(tables.identityNamespace)
          .where(
            and(
              eq(tables.identityNamespace.domain, domain),
              eq(tables.identityNamespace.active, true),
            ),
          )
          .limit(1);
        if (peer?.id != null) {
          this.discovery.refreshAfterHealthSuccess(domain, peer.id);
        }
      } catch (error) {
        // Secondary maintenance: the Health result stands regardless.
        this.logger.debug(
          `post-Health key refresh scheduling failed for ${domain}: ${(error as Error).message}`,
        );
      }
    })();
  }

  private async verifyInboundRecognize(params: {
    domain: string;
    keyId: string;
    signedRequest: SignedRequest;
    headers: OutboundSignatureHeaders;
    senderAssignedLocalNamespaceId?: number;
    signatureExpires: number;
  }): Promise<void> {
    const normalized = this.normalizeDomain(params.domain);
    const doc = await this.discovery.fetchWellKnown(normalized);
    const certificate = doc.keys.find(
      (key) =>
        key.keyId === params.keyId &&
        key.notBefore <= Date.now() &&
        Date.now() < key.notAfter,
    );
    if (!certificate) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        `keyId ${params.keyId} is not currently authorized`,
        HttpStatus.UNAUTHORIZED,
      );
    }
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
    const fingerprint = this.fingerprint(doc.rootKey.ed25519);
    const peer = await this.database.db.query.identityNamespace.findFirst({
      where: eq(tables.identityNamespace.domain, normalized),
      columns: { id: true },
    });
    if (peer?.id != null) {
      const [active] = await this.database.db
        .select({
          rootKeyFingerprint: tables.identityNamespace.rootKeyFingerprint,
          rootPublicKey: tables.identityNamespace.rootPublicKey,
        })
        .from(tables.identityNamespace)
        .where(eq(tables.identityNamespace.id, peer.id))
        .limit(1);
      if (
        active?.rootKeyFingerprint === fingerprint &&
        active.rootPublicKey === doc.rootKey.ed25519
      ) {
        const context = await this.acceptInbound(
          normalized,
          doc,
          params.senderAssignedLocalNamespaceId,
        );
        this.inboundRecognizeResults.set(normalized, {
          expiresAtMs: params.signatureExpires * 1000,
          result: {
            ok: true,
            status: 'recognized',
            peerAssignedLocalNamespaceId: context.namespaceId,
          },
        });
        return;
      }
    }

    await this.database.db.transaction(async (tx) => {
      const [matched] = await tx
        .select({
          id: tables.identityNamespace.id,
          peerAssignedLocalNamespaceId:
            tables.identityNamespace.peerAssignedLocalNamespaceId,
          rootPublicKey: tables.identityNamespace.rootPublicKey,
        })
        .from(tables.identityNamespace)
        .where(
          and(
            eq(tables.identityNamespace.rootKeyFingerprint, fingerprint),
            isNull(tables.identityNamespace.retiredAt),
            sql`${tables.identityNamespace.id} > 0`,
          ),
        )
        .limit(1);
      if (
        matched &&
        params.senderAssignedLocalNamespaceId !== undefined &&
        matched.peerAssignedLocalNamespaceId !== null &&
        params.senderAssignedLocalNamespaceId !==
          matched.peerAssignedLocalNamespaceId
      ) {
        const message = `${normalized} sender-assigned local namespace does not match pinned identity`;
        await tx
          .insert(tables.federationNamespaceCandidate)
          .values({
            nextDomain: normalized,
            matchedNamespaceId: matched.id,
            rootKeyFingerprint: fingerprint,
            rootPublicKey: doc.rootKey.ed25519,
            peerAssignedLocalNamespaceId: matched.peerAssignedLocalNamespaceId,
            status: 'failed',
            failedCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
            failedMessage: message,
            verifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: tables.federationNamespaceCandidate.nextDomain,
            set: {
              matchedNamespaceId: matched.id,
              rootKeyFingerprint: fingerprint,
              rootPublicKey: doc.rootKey.ed25519,
              peerAssignedLocalNamespaceId:
                matched.peerAssignedLocalNamespaceId,
              status: 'failed',
              failedCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
              failedMessage: message,
              verifiedAt: new Date(),
              updatedAt: new Date(),
            },
          });
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          message,
          HttpStatus.CONFLICT,
        );
      }
      const peerAssignedLocalNamespaceId =
        matched?.peerAssignedLocalNamespaceId ??
        params.senderAssignedLocalNamespaceId ??
        null;
      await tx
        .insert(tables.federationNamespaceCandidate)
        .values({
          nextDomain: normalized,
          matchedNamespaceId: matched?.id ?? null,
          rootKeyFingerprint: fingerprint,
          rootPublicKey: doc.rootKey.ed25519,
          peerAssignedLocalNamespaceId,
          status: 'pending',
          failedCode: null,
          failedMessage: null,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: tables.federationNamespaceCandidate.nextDomain,
          set: {
            matchedNamespaceId: matched?.id ?? null,
            rootKeyFingerprint: fingerprint,
            rootPublicKey: doc.rootKey.ed25519,
            peerAssignedLocalNamespaceId,
            status: 'pending',
            failedCode: null,
            failedMessage: null,
            verifiedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      if (matched) {
        await tx
          .update(tables.identityNamespace)
          .set({
            domain: normalized,
            trustLevel: 'pending',
            recognizesPeer: true,
            localServiceAvailable: true,
            peerAcceptanceConfirmed: false,
            remoteServiceReachable: false,
          })
          .where(eq(tables.identityNamespace.id, matched.id));
      }
    });
  }

  async acceptInbound(
    domain: string,
    doc: WellKnownDoc,
    senderAssignedLocalNamespaceId?: number,
  ): Promise<VerifiedFederationNamespace> {
    const normalized = this.normalizeDomain(domain);
    const fingerprint = this.fingerprint(doc.rootKey.ed25519);
    let restored = false;
    const mismatch = await this.database.db.transaction(async (tx) => {
      const peer = await this.lockPeer(tx, normalized);
      this.assertPolicyAllowsRecognition(peer, normalized);
      if (
        peer?.identityPinnedAt &&
        (peer.rootPublicKey !== doc.rootKey.ed25519 ||
          peer.rootKeyFingerprint !== fingerprint)
      ) {
        await this.markIdentityLostInTx(tx, normalized);
        return { mismatch: true as const };
      }
      const now = new Date();
      const next = {
        ...peer,
        identityPinnedAt: peer?.identityPinnedAt ?? now,
        recognizesPeer: true,
        peerAcceptanceConfirmed: true,
        localServiceAvailable: true,
        remoteServiceReachable: true,
      };
      const trustLevel = this.lifecycle(next);
      restored = this.didRecover(peer, trustLevel);
      const context = await this.namespaces.activateVerifiedInTx(tx, {
        domain: normalized,
        rootPublicKey: doc.rootKey.ed25519,
        rootKeyFingerprint: fingerprint,
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
          recognizesPeer: true,
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
      await this.initializePeerInTx(tx, context.domain, context.namespaceId);
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
      !peer.recognizesPeer ||
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
        recognizesPeer: true,
        localServiceAvailable: true,
      },
    });
    return (
      peer?.id != null &&
      peer.trustLevel !== 'halted' &&
      peer.recognizesPeer &&
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
        !peer.recognizesPeer ||
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
        !peer.recognizesPeer ||
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
    if (restored)
      this.logger.log(`Contact ${normalized}: degraded → available`);
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

  private async runRecognize(domain: string): Promise<void> {
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
      const ok = this.parseRecognizeRecognized(value);
      if (!ok) {
        await this.markTransportDegraded(
          domain,
          'Recognize malformed recognized result',
        );
        throw new Error(
          `Recognize ${domain} returned malformed recognized result`,
        );
      }
      await this.recordPeerAssignedLocalNamespace(
        domain,
        ok.peerAssignedLocalNamespaceId,
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
    } finally {
      release();
    }
  }

  private async prepareOutbound(
    domain: string,
    doc: WellKnownDoc,
  ): Promise<VerifiedFederationNamespace> {
    const fingerprint = this.fingerprint(doc.rootKey.ed25519);
    const mismatch = await this.database.db.transaction(async (tx) => {
      const peer = await this.lockPeer(tx, domain);
      this.assertPolicyAllowsRecognition(peer, domain);
      if (
        peer?.identityPinnedAt &&
        (peer.rootPublicKey !== doc.rootKey.ed25519 ||
          peer.rootKeyFingerprint !== fingerprint)
      ) {
        await this.markIdentityLostInTx(tx, domain);
        return { mismatch: true as const };
      }
      const now = new Date();
      const next = {
        ...peer,
        identityPinnedAt: peer?.identityPinnedAt ?? now,
        recognizesPeer: true,
        localServiceAvailable: true,
      };
      const trustLevel = this.lifecycle(next);
      const context = await this.namespaces.activateVerifiedInTx(tx, {
        domain,
        rootPublicKey: doc.rootKey.ed25519,
        rootKeyFingerprint: fingerprint,
        identityPinnedAt: peer?.identityPinnedAt ?? now,
      });
      await tx
        .update(tables.identityNamespace)
        .set({
          recognizesPeer: true,
          localServiceAvailable: true,
          trustLevel,
          trustedAt:
            trustLevel === 'available'
              ? (peer?.trustedAt ?? now)
              : peer?.trustedAt,
        })
        .where(eq(tables.identityNamespace.id, context.namespaceId));
      await this.initializePeerInTx(tx, context.domain, context.namespaceId);
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

  private async initializePeerInTx(
    tx: DatabaseTransaction,
    domain: string,
    namespaceId: number,
  ): Promise<void> {
    await tx
      .insert(tables.peerStateFeedPullCursor)
      .values({ peerDomain: domain, namespaceId })
      .onConflictDoNothing();
  }

  private async lockPeer(tx: DatabaseTransaction, domain: string) {
    const [peer] = await tx
      .select({
        ...getTableColumns(tables.identityNamespace),
        rootKeyFingerprint: tables.identityNamespace.rootKeyFingerprint,
        rootPublicKey: tables.identityNamespace.rootPublicKey,
        identityPinnedAt: tables.identityNamespace.identityPinnedAt,
      })
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
    if (!peer.recognizesPeer || !peer.localServiceAvailable)
      return 'unrecognized';
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

  private parseRecognizeRecognized(value: unknown): RecognizeRecognized | null {
    if (!this.isRecord(value)) return null;
    if (Object.keys(value).length !== 3) return null;
    if (value.ok !== true) return null;
    if (value.status !== 'recognized') return null;
    if (!this.isPositiveSafeInteger(value.peerAssignedLocalNamespaceId))
      return null;
    return {
      ok: true,
      status: 'recognized',
      peerAssignedLocalNamespaceId: value.peerAssignedLocalNamespaceId,
    };
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

  private fingerprint(publicKey: string): string {
    return `sha256:${createHash('sha256')
      .update(Buffer.from(publicKey, 'base64'))
      .digest('base64url')}`;
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
