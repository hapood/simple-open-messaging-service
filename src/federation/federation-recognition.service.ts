import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { DiscoveryService, type WellKnownDoc } from './discovery.service.js';
import {
  FEDERATION_PEER_HEALTH_RECOVERED,
  type FederationPeerHealthRecovered,
} from './federation-health.events.js';
import { loadFederationConfig } from './federation.config.js';
import { SignatureService } from './signature.service.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';
import {
  FederationNamespaceService,
  type FederationContext,
} from './federation-namespace.service.js';

export type FederationHealthStatus = 'available' | 'degraded' | 'unavailable';
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
    const peer = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
      columns: {
        activeNamespaceId: true,
        recognizesPeer: true,
        outboundRecognitionConfirmed: true,
        inboundRecognitionConfirmed: true,
        localServiceAvailable: true,
      },
    });
    // Health cannot prepare or pin a peer and cannot replace the OK for our outbound Recognize. Once
    // prepared, however, a positive Health result is the peer's recognition acknowledgement.
    if (
      peer?.activeNamespaceId == null ||
      !peer.recognizesPeer ||
      !peer.outboundRecognitionConfirmed ||
      !peer.inboundRecognitionConfirmed ||
      !peer.localServiceAvailable
    ) {
      await this.recognize(domain);
      return;
    }
    await this.checkHealth(domain);
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
    const base = await this.discovery.resolveBase(domain);
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
        if (response.status === HttpStatus.SERVICE_UNAVAILABLE) {
          await this.markTransportDegraded(domain, 'Health HTTP 503');
        }
        throw new Error(`Health ${domain} returned HTTP ${response.status}`);
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        value = undefined;
      }
      const result = value as {
        status?: unknown;
      } | null;
      const candidate = String(result?.status);
      const status = ['available', 'degraded', 'unavailable'].includes(
        candidate,
      )
        ? (candidate as FederationHealthStatus)
        : undefined;
      const healthShapeValid =
        !!result &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        Object.keys(result).length === 1;
      if (!status || !healthShapeValid) {
        await this.markTransportDegraded(domain, 'Health malformed response');
        throw new Error(`Health ${domain} returned malformed response`);
      }
      await this.applyHealthResult(domain, status);
      return status;
    } finally {
      release();
    }
  }

  async acceptInbound(
    domain: string,
    doc: WellKnownDoc,
  ): Promise<FederationContext> {
    const normalized = this.normalizeDomain(domain);
    const fingerprint = this.fingerprint(doc.rootKey.ed25519);
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
        inboundRecognitionConfirmed: true,
        lightweightInboundReady: true,
        localServiceAvailable: true,
        remoteServiceReachable: true,
      };
      const trustLevel = this.lifecycle(next);
      await tx
        .insert(tables.federatedPeer)
        .values({
          domain: normalized,
          trustLevel: 'available',
          recognizesPeer: true,
          inboundRecognitionConfirmed: true,
          inboundRecognizedAt: now,
          lightweightInboundReady: true,
          localServiceAvailable: true,
          remoteServiceReachable: true,
          reverseRecognitionPending: !peer?.outboundRecognitionConfirmed,
          trustedAt: now,
          lastSuccessAt: now,
        })
        .onConflictDoUpdate({
          target: tables.federatedPeer.domain,
          set: {
            recognizesPeer: true,
            inboundRecognitionConfirmed: true,
            inboundRecognizedAt: peer?.inboundRecognizedAt ?? now,
            lightweightInboundReady: true,
            localServiceAvailable: true,
            remoteServiceReachable: true,
            reverseRecognitionPending: !peer?.outboundRecognitionConfirmed,
            lastSuccessAt: now,
            degradedAt: null,
            degradationReason: null,
            trustLevel,
            trustedAt:
              trustLevel === 'available'
                ? (peer?.trustedAt ?? now)
                : peer?.trustedAt,
          },
        });
      const context = await this.namespaces.activateVerifiedInTx(tx, {
        domain: normalized,
        rootPublicKey: doc.rootKey.ed25519,
        rootKeyFingerprint: fingerprint,
        identityPinnedAt: peer?.identityPinnedAt ?? now,
      });
      await this.initializePeerInTx(tx, context.domain, context.namespaceId);
      if (!peer) {
        await tx.insert(tables.federatedPeerEvent).values({
          domain: normalized,
          type: 'discovered',
        });
      }
      return { mismatch: false as const, context };
    });
    if (mismatch.mismatch) this.throwIdentityMismatch(normalized);
    return mismatch.context;
  }

  /** Prepare the reverse direction durably, then dispatch it outside the inbound HTTP transaction. */
  dispatchReverse(domain: string): void {
    setImmediate(() => {
      void this.recognize(domain).catch((error) =>
        this.logger.debug(
          `reverse Recognize ${domain} remains pending: ${(error as Error).message}`,
        ),
      );
    });
  }

  async queryHealth(domain: string): Promise<FederationHealthStatus> {
    const peer = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, this.normalizeDomain(domain)),
    });
    if (
      !peer ||
      peer.activeNamespaceId === null ||
      !peer.recognizesPeer ||
      !peer.localServiceAvailable ||
      peer.trustLevel === 'halted'
    ) {
      return 'unavailable';
    }
    return peer.trustLevel === 'available' ? 'available' : 'degraded';
  }

  async hasPreparedPeer(domain: string): Promise<boolean> {
    const peer = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, this.normalizeDomain(domain)),
      columns: {
        activeNamespaceId: true,
        trustLevel: true,
        recognizesPeer: true,
        localServiceAvailable: true,
      },
    });
    return (
      peer?.activeNamespaceId != null &&
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
        inboundRecognitionConfirmed: true,
        lightweightInboundReady: true,
        remoteServiceReachable: true,
      };
      const trustLevel = this.lifecycle(next);
      recovered = peer.trustLevel === 'degraded' && trustLevel === 'available';
      await tx
        .update(tables.federatedPeer)
        .set({
          inboundRecognitionConfirmed: true,
          inboundRecognizedAt: peer.inboundRecognizedAt ?? now,
          lightweightInboundReady: true,
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
        .where(eq(tables.federatedPeer.domain, normalized));
    });
    // Emitted post-commit: degraded blocks outbound S2S, so head hints and pulls stop for the
    // whole degradation window; recovery is the moment the missed state has to be drained.
    if (recovered)
      this.events.emit(FEDERATION_PEER_HEALTH_RECOVERED, {
        peerDomain: normalized,
      } satisfies FederationPeerHealthRecovered);
  }

  async markReachable(domain: string): Promise<void> {
    const normalized = this.normalizeDomain(domain);
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
      await tx
        .update(tables.federatedPeer)
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
        .where(eq(tables.federatedPeer.domain, normalized));
    });
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
        .update(tables.federatedPeer)
        .set({
          trustLevel: this.lifecycle({
            ...peer,
            remoteServiceReachable: false,
          }),
          remoteServiceReachable: false,
          ...(transitioned
            ? {
                degradationCount: sql`${tables.federatedPeer.degradationCount} + 1`,
              }
            : {}),
          degradedAt: new Date(),
          degradationReason: reason.slice(0, 255),
        })
        .where(eq(tables.federatedPeer.domain, normalized));
      if (transitioned)
        await tx.insert(tables.federatedPeerEvent).values({
          domain: normalized,
          type: 'degraded',
          reason: reason.slice(0, 255),
        });
    });
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
    const body = '{}';
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
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        (value as { ok?: unknown }).ok !== true
      ) {
        await this.markTransportDegraded(domain, 'Recognize malformed OK');
        throw new Error(`Recognize ${domain} returned malformed OK`);
      }
      await this.database.db.transaction(async (tx) => {
        const peer = await this.lockPeer(tx, domain);
        if (!peer) return;
        const now = new Date();
        const next = {
          ...peer,
          outboundRecognitionConfirmed: true,
          remoteServiceReachable: true,
          reverseRecognitionPending: false,
        };
        const trustLevel = this.lifecycle(next);
        await tx
          .update(tables.federatedPeer)
          .set({
            outboundRecognitionConfirmed: true,
            outboundRecognizedAt: peer.outboundRecognizedAt ?? now,
            remoteServiceReachable: true,
            reverseRecognitionPending: false,
            lastSuccessAt: now,
            degradedAt: null,
            degradationReason: null,
            trustLevel,
            trustedAt:
              trustLevel === 'available'
                ? (peer.trustedAt ?? now)
                : peer.trustedAt,
          })
          .where(eq(tables.federatedPeer.domain, domain));
      });
    } finally {
      release();
    }
  }

  private async prepareOutbound(
    domain: string,
    doc: WellKnownDoc,
  ): Promise<FederationContext> {
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
      await tx
        .insert(tables.federatedPeer)
        .values({
          domain,
          trustLevel: 'degraded',
          recognizesPeer: true,
          localServiceAvailable: true,
        })
        .onConflictDoUpdate({
          target: tables.federatedPeer.domain,
          set: {
            recognizesPeer: true,
            localServiceAvailable: true,
            trustLevel,
            trustedAt:
              trustLevel === 'available'
                ? (peer?.trustedAt ?? now)
                : peer?.trustedAt,
          },
        });
      const context = await this.namespaces.activateVerifiedInTx(tx, {
        domain,
        rootPublicKey: doc.rootKey.ed25519,
        rootKeyFingerprint: fingerprint,
        identityPinnedAt: peer?.identityPinnedAt ?? now,
      });
      await this.initializePeerInTx(tx, context.domain, context.namespaceId);
      if (!peer) {
        await tx.insert(tables.federatedPeerEvent).values({
          domain,
          type: 'discovered',
        });
      }
      return { mismatch: false as const, context };
    });
    if (mismatch.mismatch) this.throwIdentityMismatch(domain);
    return mismatch.context;
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
        ...getTableColumns(tables.federatedPeer),
        rootKeyFingerprint: tables.identityNamespace.rootKeyFingerprint,
        rootPublicKey: tables.identityNamespace.rootPublicKey,
        identityPinnedAt: tables.identityNamespace.identityPinnedAt,
      })
      .from(tables.federatedPeer)
      .leftJoin(
        tables.identityNamespace,
        and(
          eq(
            tables.identityNamespace.id,
            tables.federatedPeer.activeNamespaceId,
          ),
          eq(tables.identityNamespace.domain, tables.federatedPeer.domain),
        ),
      )
      .where(eq(tables.federatedPeer.domain, domain))
      .for('no key update', { of: tables.federatedPeer })
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
      .update(tables.federatedPeer)
      .set({
        trustLevel: 'halted',
        remoteServiceReachable: false,
        haltedAt: new Date(),
        haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        haltReason: reason,
      })
      .where(eq(tables.federatedPeer.domain, domain));
    await tx.insert(tables.federatedPeerEvent).values({
      domain,
      type: 'halted',
      reason,
    });
  }

  private lifecycle(
    peer: Partial<typeof tables.federatedPeer.$inferSelect> & {
      identityPinnedAt?: Date | null;
    },
  ): string {
    if (peer.trustLevel === 'halted') {
      return 'halted';
    }
    if (!peer.identityPinnedAt) return 'unrecognized';
    if (!peer.recognizesPeer || !peer.localServiceAvailable)
      return 'establishing';
    return peer.remoteServiceReachable ? 'available' : 'degraded';
  }

  private async handleRecognizeHttpFailure(
    domain: string,
    response: Response,
  ): Promise<never> {
    const value = (await response.json().catch(() => undefined)) as
      | { code?: unknown; message?: unknown }
      | undefined;
    const code = typeof value?.code === 'number' ? value.code : undefined;
    const message =
      typeof value?.message === 'string'
        ? value.message
        : `Recognize ${domain} returned HTTP ${response.status}`;
    if (response.status === HttpStatus.CONFLICT && this.isFatalCode(code)) {
      await this.markHalted(domain, code, message);
      throw new BusinessException(code, message, HttpStatus.CONFLICT);
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
      .update(tables.federatedPeer)
      .set({
        trustLevel: 'halted',
        remoteServiceReachable: false,
        haltedAt: new Date(),
        haltCode: code,
        haltReason: reason.slice(0, 255),
      })
      .where(eq(tables.federatedPeer.domain, domain));
  }

  private isFatalCode(code: unknown): code is number {
    return [
      BusinessCode.FEDERATION_PEER_BLOCKED,
      BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      BusinessCode.FEDERATION_PROTOCOL_VERSION_UNSUPPORTED,
    ].includes(code as BusinessCode);
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
