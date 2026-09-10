import { HttpStatus, Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, isNull, lt, or } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { DiscoveryService } from './discovery.service.js';
import {
  FEDERATION_PROTOCOL_VERSION,
  selectFederationProtocolVersion,
} from './federation-protocol.js';
import { FederationRecognitionService } from './federation-recognition.service.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationTransportError } from './federation-errors.js';

/** Owns peer trust state, liveness bookkeeping, and administrative lifecycle operations. */
@Injectable()
export class FederationPeerLifecycle {
  private static readonly LAST_SUCCESS_WINDOW_MS = 60_000;
  private readonly lastSuccessSentAt = new Map<string, number>();
  private readonly ourDomain = loadFederationConfig().domain;

  constructor(
    private readonly database: DatabaseService,
    private readonly recognition: FederationRecognitionService,
    private readonly discovery: DiscoveryService,
  ) {}

  /** Pure local gate for an ordinary outbound S2S operation. Never starts recognition or network IO. */
  async checkOutboundReady(domain: string): Promise<void> {
    if (domain === this.ourDomain) return;
    const existing = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
    });
    if (existing?.trustLevel === 'halted') {
      const code = this.isFatalCode(existing.haltCode)
        ? existing.haltCode
        : BusinessCode.FEDERATION_IDENTITY_MISMATCH;
      throw new BusinessException(
        code,
        existing.haltReason ?? `${domain} federation relationship is halted`,
        HttpStatus.CONFLICT,
      );
    }
    if (existing?.trustLevel === 'degraded') {
      throw new FederationTransportError(
        `${domain} is degraded; waiting for Health recovery`,
      );
    }
    if (
      existing?.trustLevel === 'available' &&
      existing?.activeNamespaceId != null &&
      existing.recognizesPeer &&
      existing.localServiceAvailable &&
      existing.outboundRecognitionConfirmed &&
      existing.inboundRecognitionConfirmed
    )
      return;
    throw new BusinessException(
      BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
      `${domain} recognition directions are incomplete`,
      HttpStatus.UNAUTHORIZED,
    );
  }

  /** Explicit recovery path used by the reconnect worker, never by a business read or write. */
  async recoverPeerRecognition(domain: string): Promise<void> {
    const peer = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
      columns: {
        trustLevel: true,
        outboundRecognitionConfirmed: true,
        inboundRecognitionConfirmed: true,
        reverseRecognitionPending: true,
      },
    });
    if (
      peer?.trustLevel === 'halted' ||
      (peer?.trustLevel === 'available' &&
        peer.outboundRecognitionConfirmed &&
        peer.inboundRecognitionConfirmed &&
        !peer.reverseRecognitionPending)
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
        `${domain} is not eligible for automatic recovery`,
        HttpStatus.CONFLICT,
      );
    }
    await this.recognition.recognize(domain);
  }

  /** Pure local recognition check used only to choose whether an explicit bootstrap is required. */
  async hasCompleteRecognition(domain: string): Promise<boolean> {
    if (domain === this.ourDomain) return true;
    const existing = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
    });
    return (
      existing?.trustLevel !== 'halted' &&
      existing?.activeNamespaceId != null &&
      existing.recognizesPeer &&
      existing.localServiceAvailable &&
      existing.outboundRecognitionConfirmed &&
      existing.inboundRecognitionConfirmed
    );
  }

  /** Explicit signed Health round trip. An available/degraded result acknowledges peer recognition
   * and refreshes reachability; unavailable only degrades reachability. */
  async checkHealth(domain: string) {
    return this.recognition.checkHealth(domain);
  }

  async markContactSuccess(domain: string): Promise<void> {
    try {
      await this.recognition.markReachable(domain);
    } catch {
      // Reachability bookkeeping is secondary to the completed operation.
    }
    const now = Date.now();
    const last = this.lastSuccessSentAt.get(domain);
    if (
      last !== undefined &&
      now - last < FederationPeerLifecycle.LAST_SUCCESS_WINDOW_MS
    ) {
      return;
    }
    this.lastSuccessSentAt.set(domain, now);
    try {
      await this.database.db
        .update(tables.federatedPeer)
        .set({ lastSuccessAt: new Date(now) })
        .where(
          and(
            eq(tables.federatedPeer.domain, domain),
            or(
              isNull(tables.federatedPeer.lastSuccessAt),
              lt(
                tables.federatedPeer.lastSuccessAt,
                new Date(now - FederationPeerLifecycle.LAST_SUCCESS_WINDOW_MS),
              ),
            ),
          ),
        );
    } catch {
      // Best-effort liveness watermark — never break the caller's operation.
    }
  }

  async markRecovered(domain: string): Promise<void> {
    await this.recognition.markReachable(domain);
  }

  isFatalCode(code: unknown): code is number {
    return [
      BusinessCode.FEDERATION_PEER_BLOCKED,
      BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      BusinessCode.FEDERATION_PROTOCOL_VERSION_UNSUPPORTED,
    ].includes(code as BusinessCode);
  }

  isFatalPeerCode(code: unknown): code is number {
    return this.isFatalCode(code);
  }

  async markHalted(
    domain: string,
    code: number,
    message: unknown,
  ): Promise<void> {
    const reason =
      typeof message === 'string'
        ? message
        : `peer returned fatal federation code ${code}`;
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
    await this.logEvent(domain, 'halted', reason);
  }

  async markPeerHalted(
    domain: string,
    code: number,
    message: unknown,
  ): Promise<void> {
    await this.markHalted(domain, code, message);
  }

  async markBlocked(domain: string, note?: string): Promise<void> {
    const existing = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
    });
    if (
      existing?.trustLevel === 'halted' &&
      existing.haltCode === BusinessCode.FEDERATION_PEER_BLOCKED
    ) {
      return;
    }
    const now = new Date();
    await this.database.db
      .insert(tables.federatedPeer)
      .values({
        domain,
        trustLevel: 'halted',
        haltedAt: now,
        haltCode: BusinessCode.FEDERATION_PEER_BLOCKED,
        haltReason: note ?? 'blocked by local policy',
      })
      .onConflictDoUpdate({
        target: tables.federatedPeer.domain,
        set: {
          trustLevel: 'halted',
          haltedAt: now,
          haltCode: BusinessCode.FEDERATION_PEER_BLOCKED,
          haltReason: note ?? 'blocked by local policy',
        },
      });
    await this.logEvent(domain, 'halted', note ?? 'blocked by local policy');
  }

  async markUnblocked(domain: string): Promise<void> {
    const existing = await this.database.db.query.federatedPeer.findFirst({
      where: eq(tables.federatedPeer.domain, domain),
    });
    if (
      !existing ||
      existing.trustLevel !== 'halted' ||
      existing.haltCode !== BusinessCode.FEDERATION_PEER_BLOCKED
    ) {
      return;
    }
    const trustLevel =
      existing.activeNamespaceId === null
        ? 'unrecognized'
        : existing.recognizesPeer && existing.localServiceAvailable
          ? existing.remoteServiceReachable
            ? 'available'
            : 'degraded'
          : 'establishing';
    await this.database.db
      .update(tables.federatedPeer)
      .set({
        trustLevel,
        haltedAt: null,
        haltCode: null,
        haltReason: null,
      })
      .where(eq(tables.federatedPeer.domain, domain));
    await this.logEvent(domain, 'unblocked');
  }

  async list(opts: {
    skip: number;
    take: number;
    search?: string;
    status?: string;
  }) {
    const where = and(
      ...(opts.search
        ? [ilike(tables.federatedPeer.domain, `%${opts.search}%`)]
        : []),
      ...(opts.status
        ? [eq(tables.federatedPeer.trustLevel, opts.status)]
        : []),
    );
    const [list, total] = await Promise.all([
      this.database.db.query.federatedPeer.findMany({
        where,
        offset: opts.skip,
        limit: opts.take,
        orderBy: desc(tables.federatedPeer.createdAt),
      }),
      this.database.db
        .select({ value: count() })
        .from(tables.federatedPeer)
        .where(where)
        .then(([row]) => row.value),
    ]);
    return { list, total };
  }

  async events(domain: string, take = 100) {
    return this.database.db.query.federatedPeerEvent.findMany({
      where: eq(tables.federatedPeerEvent.domain, domain),
      orderBy: desc(tables.federatedPeerEvent.createdAt),
      limit: take,
    });
  }

  async manuallyRecoverPinnedIdentity(
    peerDomain: string,
    confirmDomain: string,
  ): Promise<{ domain: string; trustLevel: 'degraded' }> {
    const domain = peerDomain.trim().toLowerCase().replace(/\.+$/, '');
    if (confirmDomain.trim().toLowerCase().replace(/\.+$/, '') !== domain) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'confirmDomain must exactly match the peer domain',
        HttpStatus.BAD_REQUEST,
      );
    }
    const [peer] = await this.database.db
      .select({
        trustLevel: tables.federatedPeer.trustLevel,
        haltCode: tables.federatedPeer.haltCode,
        activeNamespaceId: tables.federatedPeer.activeNamespaceId,
        rootKeyFingerprint: tables.identityNamespace.rootKeyFingerprint,
        rootPublicKey: tables.identityNamespace.rootPublicKey,
      })
      .from(tables.federatedPeer)
      .innerJoin(
        tables.identityNamespace,
        eq(tables.identityNamespace.id, tables.federatedPeer.activeNamespaceId),
      )
      .where(eq(tables.federatedPeer.domain, domain))
      .limit(1);
    if (
      peer?.trustLevel !== 'halted' ||
      peer.haltCode !== BusinessCode.FEDERATION_IDENTITY_MISMATCH ||
      peer.activeNamespaceId === null ||
      !peer.rootKeyFingerprint ||
      !peer.rootPublicKey
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `${domain} is not an idle identity-mismatch halted peer with complete pinned evidence`,
        HttpStatus.CONFLICT,
      );
    }

    this.discovery.invalidateBase(domain);
    const doc = await this.discovery.fetchWellKnown(domain);
    const publishedKey = doc.keys[0];
    const originalIdentityReturned =
      selectFederationProtocolVersion(doc.protocolVersions) ===
        FEDERATION_PROTOCOL_VERSION &&
      doc.rootKey.ed25519 === peer.rootPublicKey;
    if (!originalIdentityReturned || !publishedKey) {
      throw new BusinessException(
        BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        `${domain} still does not present the original pinned identity`,
        HttpStatus.CONFLICT,
      );
    }

    await this.discovery.cacheDocument(domain, peer.activeNamespaceId, doc);
    await this.database.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          trustLevel: tables.federatedPeer.trustLevel,
          haltCode: tables.federatedPeer.haltCode,
          activeNamespaceId: tables.federatedPeer.activeNamespaceId,
        })
        .from(tables.federatedPeer)
        .where(eq(tables.federatedPeer.domain, domain))
        .for('no key update')
        .limit(1);
      if (
        locked?.trustLevel !== 'halted' ||
        locked.haltCode !== BusinessCode.FEDERATION_IDENTITY_MISMATCH ||
        locked.activeNamespaceId !== peer.activeNamespaceId
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          `${domain} pinned identity changed during recovery`,
          HttpStatus.CONFLICT,
        );
      }
      await tx
        .update(tables.federatedPeer)
        .set({
          trustLevel: 'degraded',
          remoteServiceReachable: false,
          haltedAt: null,
          haltCode: null,
          haltReason: null,
          degradedAt: null,
          degradationReason: null,
          lastSuccessAt: new Date(),
        })
        .where(eq(tables.federatedPeer.domain, domain));
      await tx.insert(tables.federatedPeerEvent).values({
        domain,
        type: 'recovered',
        reason: 'administrator verified the original pinned identity',
      });
    });
    return { domain, trustLevel: 'degraded' };
  }

  private async logEvent(
    domain: string,
    type: string,
    reason?: string,
  ): Promise<void> {
    try {
      await this.database.db.insert(tables.federatedPeerEvent).values({
        domain,
        type,
        reason: reason ? reason.slice(0, 255) : null,
      });
    } catch {
      // Audit rows are secondary to peer state transitions.
    }
  }
}
