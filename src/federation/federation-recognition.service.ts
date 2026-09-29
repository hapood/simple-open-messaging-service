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
import { parsePeerErrorBody } from './federation-errors.js';
import {
  FEDERATION_PEER_AVAILABLE,
  type FederationPeerAvailable,
} from './federation-peer.events.js';
import { loadFederationConfig } from './federation.config.js';
import { SignatureService } from './signature.service.js';
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

interface RecognizeOk {
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
    const peer = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
      columns: {
        activeNamespaceId: true,
        recognizesPeer: true,
        peerAcceptanceConfirmed: true,
        localServiceAvailable: true,
      },
    });
    // Health can confirm peer acceptance only after local identity preparation.
    if (
      peer?.activeNamespaceId == null ||
      !peer.recognizesPeer ||
      !peer.localServiceAvailable
    ) {
      await this.recognize(domain);
      return;
    }
    const status = await this.checkHealth(domain);
    if (status === 'unavailable' && !peer.peerAcceptanceConfirmed)
      await this.recognize(domain);
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

  async acceptInbound(
    domain: string,
    doc: WellKnownDoc,
    namespaceEcho?: number,
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
      restored = await this.logRecoveryInTx(
        tx,
        normalized,
        peer,
        trustLevel,
        'signed Recognize handshake restored reachability',
      );
      await tx
        .insert(tables.federatedPeer)
        .values({
          domain: normalized,
          trustLevel: 'available',
          recognizesPeer: true,
          peerAcceptanceConfirmed: true,
          localServiceAvailable: true,
          remoteServiceReachable: true,
          trustedAt: now,
          lastSuccessAt: now,
        })
        .onConflictDoUpdate({
          target: tables.federatedPeer.domain,
          set: {
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
          },
        });
      const context = await this.namespaces.activateVerifiedInTx(tx, {
        domain: normalized,
        rootPublicKey: doc.rootKey.ed25519,
        rootKeyFingerprint: fingerprint,
        identityPinnedAt: peer?.identityPinnedAt ?? now,
      });
      if (
        namespaceEcho !== undefined &&
        peer?.activeNamespaceId !== null &&
        peer?.activeNamespaceId !== undefined &&
        namespaceEcho !== context.namespaceId
      ) {
        await this.markIdentityLostInTx(tx, normalized);
        return { mismatch: true as const };
      }
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
    if (restored)
      this.logger.log(`Recognize ${normalized}: degraded → available`);
    this.emitPeerAvailable(normalized);
    return mismatch.context;
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
    return peer.remoteServiceReachable ? 'available' : 'degraded';
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
      restored = await this.logRecoveryInTx(
        tx,
        normalized,
        peer,
        trustLevel,
        'Health round trip restored reachability',
      );
      await tx
        .update(tables.federatedPeer)
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
        .where(eq(tables.federatedPeer.domain, normalized));
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
      restored = await this.logRecoveryInTx(
        tx,
        normalized,
        peer,
        trustLevel,
        'signed S2S contact restored reachability',
      );
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

  /** The mirror of markTransportDegraded's `transitioned` guard: exactly when a DEGRADED peer returns
   *  to 'available' — via a Health round trip, an inbound Recognize handshake or an ordinary signed
   *  S2S contact — append the 'available' audit event in the same tx, so the admin timeline tells
   *  both halves of the degradation story. Returns whether the event was written. */
  private async logRecoveryInTx(
    tx: DatabaseTransaction,
    domain: string,
    peer:
      | Pick<typeof tables.federatedPeer.$inferSelect, 'trustLevel'>
      | undefined,
    trustLevel: string,
    reason: string,
  ): Promise<boolean> {
    if (peer?.trustLevel !== 'degraded' || trustLevel !== 'available')
      return false;
    await tx.insert(tables.federatedPeerEvent).values({
      domain,
      type: 'available',
      reason: reason.slice(0, 255),
    });
    return true;
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
    const body = context.peerAssignedLocalNamespaceId
      ? JSON.stringify({ namespaceId: context.peerAssignedLocalNamespaceId })
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
      const ok = this.parseRecognizeOk(value);
      if (!ok) {
        await this.markTransportDegraded(domain, 'Recognize malformed OK');
        throw new Error(`Recognize ${domain} returned malformed OK`);
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
          .update(tables.federatedPeer)
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
          .where(eq(tables.federatedPeer.domain, domain));
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
      await tx
        .insert(tables.federatedPeer)
        .values({
          domain,
          trustLevel: 'establishing',
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

  private parseRecognizeOk(value: unknown): RecognizeOk | null {
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
    if (value.status !== 'available' && value.status !== 'degraded') return null;
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
    return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
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
