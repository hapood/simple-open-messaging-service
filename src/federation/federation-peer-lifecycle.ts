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
import { FederationTransportError } from './federation-errors.js';

/** Owns peer trust state, liveness bookkeeping, and administrative lifecycle operations. */
@Injectable()
export class FederationPeerLifecycle {
  private static readonly LAST_SUCCESS_WINDOW_MS = 60_000;
  private readonly lastSuccessSentAt = new Map<string, number>();

  constructor(
    private readonly database: DatabaseService,
    private readonly recognition: FederationRecognitionService,
    private readonly discovery: DiscoveryService,
  ) {}

  /** Pure local gate for an ordinary outbound S2S operation. Never starts recognition or network IO. */
  async checkOutboundReady(domain: string): Promise<void> {
    const existing = await this.database.db.query.identityNamespace.findFirst({
      where: eq(tables.identityNamespace.domain, domain),
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
      existing?.active === true &&
      existing.recognizesPeer &&
      existing.localServiceAvailable &&
      existing.peerAcceptanceConfirmed
    )
      return;
    throw new BusinessException(
      BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
      `${domain} peer acceptance is not established`,
      HttpStatus.UNAUTHORIZED,
    );
  }

  /** Explicit recovery path used by the reconnect worker, never by a business read or write. */
  async recoverPeerRecognition(domain: string): Promise<void> {
    const peer = await this.database.db.query.identityNamespace.findFirst({
      where: eq(tables.identityNamespace.domain, domain),
      columns: { trustLevel: true },
    });
    if (peer?.trustLevel !== 'establishing') {
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
    const existing = await this.database.db.query.identityNamespace.findFirst({
      where: eq(tables.identityNamespace.domain, domain),
    });
    return (
      existing?.trustLevel !== 'halted' &&
      existing?.active === true &&
      existing.recognizesPeer &&
      existing.localServiceAvailable &&
      existing.peerAcceptanceConfirmed
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
        .update(tables.identityNamespace)
        .set({ lastSuccessAt: new Date(now) })
        .where(
          and(
            eq(tables.identityNamespace.domain, domain),
            or(
              isNull(tables.identityNamespace.lastSuccessAt),
              lt(
                tables.identityNamespace.lastSuccessAt,
                new Date(now - FederationPeerLifecycle.LAST_SUCCESS_WINDOW_MS),
              ),
            ),
          ),
        );
    } catch {
      // Best-effort liveness watermark — never break the caller's operation.
    }
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
    message: string | undefined,
  ): Promise<void> {
    const reason = message ?? `peer returned fatal federation code ${code}`;
    await this.database.db
      .update(tables.identityNamespace)
      .set({
        trustLevel: 'halted',
        remoteServiceReachable: false,
        haltedAt: new Date(),
        haltCode: code,
        haltReason: reason.slice(0, 255),
      })
      .where(eq(tables.identityNamespace.domain, domain));
  }

  async markPeerHalted(
    domain: string,
    code: number,
    message: string | undefined,
  ): Promise<void> {
    await this.markHalted(domain, code, message);
  }

  async markBlocked(domain: string, note?: string): Promise<void> {
    const existing = await this.database.db.query.identityNamespace.findFirst({
      where: eq(tables.identityNamespace.domain, domain),
    });
    if (
      existing?.trustLevel === 'halted' &&
      existing.haltCode === BusinessCode.FEDERATION_PEER_BLOCKED
    ) {
      return;
    }
    if (!existing) return;
    const now = new Date();
    await this.database.db
      .update(tables.identityNamespace)
      .set({
        trustLevel: 'halted',
        haltedAt: now,
        haltCode: BusinessCode.FEDERATION_PEER_BLOCKED,
        haltReason: note ?? 'blocked by local policy',
      })
      .where(eq(tables.identityNamespace.id, existing.id));
  }

  async markUnblocked(domain: string): Promise<void> {
    const existing = await this.database.db.query.identityNamespace.findFirst({
      where: eq(tables.identityNamespace.domain, domain),
    });
    if (
      !existing ||
      existing.trustLevel !== 'halted' ||
      existing.haltCode !== BusinessCode.FEDERATION_PEER_BLOCKED
    ) {
      return;
    }
    const trustLevel =
      !existing.active
        ? 'unrecognized'
        : existing.recognizesPeer && existing.localServiceAvailable
          ? !existing.peerAcceptanceConfirmed
            ? 'establishing'
            : existing.remoteServiceReachable
              ? 'available'
              : 'degraded'
          : 'unrecognized';
    await this.database.db
      .update(tables.identityNamespace)
      .set({
        trustLevel,
        haltedAt: null,
        haltCode: null,
        haltReason: null,
      })
      .where(eq(tables.identityNamespace.domain, domain));
  }

  async list(opts: {
    skip: number;
    take: number;
    search?: string;
    status?: string;
  }) {
    const where = and(
      ...(opts.search
        ? [ilike(tables.identityNamespace.domain, `%${opts.search}%`)]
        : []),
      ...(opts.status
        ? [eq(tables.identityNamespace.trustLevel, opts.status)]
        : []),
    );
    const [list, total] = await Promise.all([
      this.database.db.query.identityNamespace.findMany({
        where,
        offset: opts.skip,
        limit: opts.take,
        orderBy: desc(tables.identityNamespace.createdAt),
      }),
      this.database.db
        .select({ value: count() })
        .from(tables.identityNamespace)
        .where(where)
        .then(([row]) => row.value),
    ]);
    return { list, total };
  }

  async manuallyRecoverPinnedIdentity(
    peerDomain: string,
    confirmDomain: string,
  ): Promise<{
    domain: string;
    trustLevel: 'unrecognized' | 'establishing' | 'degraded';
  }> {
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
        trustLevel: tables.identityNamespace.trustLevel,
        haltCode: tables.identityNamespace.haltCode,
        id: tables.identityNamespace.id,
        rootKeyFingerprint: tables.identityNamespace.rootKeyFingerprint,
        rootPublicKey: tables.identityNamespace.rootPublicKey,
      })
      .from(tables.identityNamespace)
            .where(eq(tables.identityNamespace.domain, domain))
      .limit(1);
    if (
      peer?.trustLevel !== 'halted' ||
      peer.haltCode !== BusinessCode.FEDERATION_IDENTITY_MISMATCH ||
      peer.id === null ||
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

    await this.discovery.cacheDocument(domain, peer.id, doc);
    const trustLevel = await this.database.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({
          trustLevel: tables.identityNamespace.trustLevel,
          haltCode: tables.identityNamespace.haltCode,
          id: tables.identityNamespace.id,
          recognizesPeer: tables.identityNamespace.recognizesPeer,
          localServiceAvailable: tables.identityNamespace.localServiceAvailable,
          peerAcceptanceConfirmed: tables.identityNamespace.peerAcceptanceConfirmed,
        })
        .from(tables.identityNamespace)
        .where(eq(tables.identityNamespace.domain, domain))
        .for('no key update')
        .limit(1);
      if (
        locked?.trustLevel !== 'halted' ||
        locked.haltCode !== BusinessCode.FEDERATION_IDENTITY_MISMATCH ||
        locked.id !== peer.id
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          `${domain} pinned identity changed during recovery`,
          HttpStatus.CONFLICT,
        );
      }
      const trustLevel =
        !locked.recognizesPeer || !locked.localServiceAvailable
          ? 'unrecognized'
          : locked.peerAcceptanceConfirmed
            ? 'degraded'
            : 'establishing';
      await tx
        .update(tables.identityNamespace)
        .set({
          trustLevel,
          remoteServiceReachable: false,
          haltedAt: null,
          haltCode: null,
          haltReason: null,
          degradedAt: null,
          degradationReason: null,
          lastSuccessAt: new Date(),
        })
        .where(eq(tables.identityNamespace.domain, domain));
      return trustLevel;
    });
    return { domain, trustLevel };
  }

}
