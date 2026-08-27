import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { FederationCursorService } from './federation-cursor.service.js';
import { DiscoveryService, type WellKnownDoc } from './discovery.service.js';
import { loadFederationConfig } from './federation.config.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';
import { SignatureService } from './signature.service.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';

export type FederationHealthStatus = 'available' | 'degraded' | 'unavailable';
export type FederationRecognitionStage =
  | 'DISCOVERING'
  | 'VERIFYING_IDENTITY'
  | 'CONNECTING'
  | 'WAITING_FOR_PEER';

@Injectable()
export class FederationRecognitionService {
  private readonly config = loadFederationConfig();
  private readonly logger = new Logger(FederationRecognitionService.name);
  private readonly inFlight = new Map<string, Promise<void>>();
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
    private readonly cursor: FederationCursorService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly transportConfig: FederationTransportConfigService,
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
        identityPinnedAt: true,
        recognizesPeer: true,
        outboundRecognitionConfirmed: true,
        inboundRecognitionConfirmed: true,
        localServiceAvailable: true,
      },
    });
    // Health is an availability probe, not a bootstrap operation. A peer may legitimately answer
    // `degraded` while this side has no post-reset recognition row at all; treating that response as
    // sufficient would let ensurePeerTrusted return before the local authorization facts exist.
    if (
      !peer?.identityPinnedAt ||
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

  async acceptInbound(domain: string, doc: WellKnownDoc): Promise<void> {
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
        return true;
      }
      const now = new Date();
      const next = {
        ...peer,
        identityPinnedAt: peer?.identityPinnedAt ?? now,
        inboundRecognitionConfirmed: true,
        lightweightInboundReady: true,
        localServiceAvailable:
          peer?.localServiceAvailable || peer?.recognizesPeer || false,
      };
      const trustLevel = this.lifecycle(next);
      await tx
        .insert(tables.federatedPeer)
        .values({
          domain: normalized,
          trustLevel: 'establishing',
          rootPublicKey: doc.rootKey.ed25519,
          rootKeyFingerprint: fingerprint,
          identityPinnedAt: now,
          inboundRecognitionConfirmed: true,
          inboundRecognizedAt: now,
          lightweightInboundReady: true,
          reverseRecognitionPending: !peer?.outboundRecognitionConfirmed,
        })
        .onConflictDoUpdate({
          target: tables.federatedPeer.domain,
          set: {
            rootPublicKey: doc.rootKey.ed25519,
            rootKeyFingerprint: fingerprint,
            identityPinnedAt: peer?.identityPinnedAt ?? now,
            inboundRecognitionConfirmed: true,
            inboundRecognizedAt: peer?.inboundRecognizedAt ?? now,
            lightweightInboundReady: true,
            localServiceAvailable:
              peer?.localServiceAvailable || peer?.recognizesPeer || false,
            reverseRecognitionPending: !peer?.outboundRecognitionConfirmed,
            trustLevel,
            trustedAt:
              trustLevel === 'available'
                ? (peer?.trustedAt ?? now)
                : peer?.trustedAt,
          },
        });
      await this.initializePeerInTx(tx, normalized);
      if (!peer) {
        await tx.insert(tables.federatedPeerEvent).values({
          domain: normalized,
          type: 'discovered',
        });
      }
      return false;
    });
    if (mismatch) this.throwIdentityMismatch(normalized);
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
      !peer.identityPinnedAt ||
      !peer.inboundRecognitionConfirmed ||
      !peer.localServiceAvailable ||
      peer.trustLevel === 'halted' ||
      peer.resetInProgress
    ) {
      return 'unavailable';
    }
    return peer.trustLevel === 'available' ? 'available' : 'degraded';
  }

  async hasPinnedIdentity(domain: string): Promise<boolean> {
    const peer = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, this.normalizeDomain(domain)),
      columns: {
        identityPinnedAt: true,
        trustLevel: true,
        resetInProgress: true,
      },
    });
    return (
      !!peer?.identityPinnedAt &&
      peer.trustLevel !== 'halted' &&
      !peer.resetInProgress
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
    await this.database.db.transaction(async (tx) => {
      const peer = await this.lockPeer(tx, normalized);
      if (
        !peer ||
        !peer.identityPinnedAt ||
        peer.trustLevel === 'halted' ||
        peer.resetInProgress
      )
        return;
      const now = new Date();
      const next = {
        ...peer,
        remoteServiceReachable: true,
      };
      const trustLevel = this.lifecycle(next);
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

  async markReachable(domain: string): Promise<void> {
    const normalized = this.normalizeDomain(domain);
    await this.database.db.transaction(async (tx) => {
      const peer = await this.lockPeer(tx, normalized);
      if (
        !peer ||
        !peer.identityPinnedAt ||
        peer.trustLevel === 'halted' ||
        peer.resetInProgress
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
        peer.resetInProgress ||
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
    await this.prepareOutbound(domain, doc);
    await this.discovery.cacheDocument(domain, doc);
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
    this.publishProgress(domain, 'WAITING_FOR_PEER');
    await this.awaitBidirectionalConvergence(domain);
    // A destructive reset keeps a generation tombstone so in-flight pre-reset responses remain
    // fenced. Consume only its reinitialization flag after fresh bidirectional recognition has fully
    // converged; the generation itself remains durable for stale-response comparisons.
    await this.database.db
      .update(tables.federatedPeerReset)
      .set({ reinitPending: false })
      .where(eq(tables.federatedPeerReset.domain, domain));
  }

  private async awaitBidirectionalConvergence(domain: string): Promise<void> {
    const deadline =
      Date.now() + this.transportConfig.get().callTimeoutSec * 1000;
    let lastStatus: FederationHealthStatus = 'unavailable';
    while (Date.now() < deadline) {
      const peer = await this.database.db.query.federatedPeer.findFirst({
        where: eq(tables.federatedPeer.domain, domain),
        columns: {
          trustLevel: true,
          recognizesPeer: true,
          outboundRecognitionConfirmed: true,
          inboundRecognitionConfirmed: true,
          localServiceAvailable: true,
          remoteServiceReachable: true,
        },
      });
      if (
        peer?.recognizesPeer &&
        peer.outboundRecognitionConfirmed &&
        peer.inboundRecognitionConfirmed &&
        peer.localServiceAvailable &&
        peer.remoteServiceReachable
      ) {
        if (peer.trustLevel !== 'available') await this.markReachable(domain);
        return;
      }
      try {
        lastStatus = await this.checkHealth(domain);
      } catch {
        // The reverse Recognize may still be crossing; retry only within this initiating operation.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `bidirectional Recognize with ${domain} did not converge (Health=${lastStatus})`,
    );
  }

  private async prepareOutbound(
    domain: string,
    doc: WellKnownDoc,
  ): Promise<void> {
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
        return true;
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
          trustLevel: 'establishing',
          rootPublicKey: doc.rootKey.ed25519,
          rootKeyFingerprint: fingerprint,
          identityPinnedAt: now,
          recognizesPeer: true,
          localServiceAvailable: true,
        })
        .onConflictDoUpdate({
          target: tables.federatedPeer.domain,
          set: {
            rootPublicKey: doc.rootKey.ed25519,
            rootKeyFingerprint: fingerprint,
            identityPinnedAt: peer?.identityPinnedAt ?? now,
            recognizesPeer: true,
            localServiceAvailable: true,
            trustLevel,
            trustedAt:
              trustLevel === 'available'
                ? (peer?.trustedAt ?? now)
                : peer?.trustedAt,
          },
        });
      await this.initializePeerInTx(tx, domain);
      if (!peer) {
        await tx.insert(tables.federatedPeerEvent).values({
          domain,
          type: 'discovered',
        });
      }
      return false;
    });
    if (mismatch) this.throwIdentityMismatch(domain);
  }

  private async initializePeerInTx(
    tx: DatabaseTransaction,
    domain: string,
  ): Promise<void> {
    await this.cursor.initializePeerInTx(tx, domain, 0n);
    await tx
      .insert(tables.federationTombstoneServeCursor)
      .values({ peerDomain: domain })
      .onConflictDoNothing();
    await tx
      .insert(tables.federationTombstonePullCursor)
      .values({ peerDomain: domain })
      .onConflictDoNothing();
    await this.stateFeed.initializePeerInTx(tx, domain);
    await tx
      .insert(tables.peerStateFeedPullCursor)
      .values({ peerDomain: domain })
      .onConflictDoNothing();
  }

  private async lockPeer(tx: DatabaseTransaction, domain: string) {
    const [peer] = await tx
      .select()
      .from(tables.federatedPeer)
      .where(eq(tables.federatedPeer.domain, domain))
      .for('update')
      .limit(1);
    return peer;
  }

  private assertPolicyAllowsRecognition(
    peer: typeof tables.federatedPeer.$inferSelect | undefined,
    domain: string,
  ): void {
    if (peer?.trustLevel === 'halted' && !peer.resetInProgress) {
      const code = this.isFatalCode(peer.haltCode)
        ? peer.haltCode
        : BusinessCode.FEDERATION_IDENTITY_MISMATCH;
      throw new BusinessException(
        code,
        `${domain} federation relationship is halted`,
        HttpStatus.CONFLICT,
      );
    }
    if (peer?.resetInProgress)
      throw new BusinessException(
        BusinessCode.INTERNAL,
        `${domain} federation relationship is under administrative maintenance`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
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
    peer: Partial<typeof tables.federatedPeer.$inferSelect>,
  ): string {
    if (peer.trustLevel === 'halted' || peer.resetInProgress) {
      return 'halted';
    }
    if (!peer.identityPinnedAt) return 'unrecognized';
    const established =
      peer.recognizesPeer &&
      peer.outboundRecognitionConfirmed &&
      peer.inboundRecognitionConfirmed &&
      peer.localServiceAvailable;
    if (!established) return 'establishing';
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
