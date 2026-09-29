import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { lookup, type LookupAddress } from 'node:dns';
import { resolveSrv } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Agent, fetch as undiciFetch } from 'undici';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import {
  type SigningKeyCertificate,
  verifySigningCertificate,
} from './federation-certificate.js';
import { loadFederationConfig } from './federation.config.js';
import { parseKeyId } from './key-id.js';
import {
  continuousCoverageEnd,
  type CoverageInterval,
} from './peer-key-coverage.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';
import { KeypairService } from './keypair.service.js';
import { selectFederationProtocolVersion } from './federation-protocol.js';
import { FederationHttpScheduler } from './federation-http-scheduler.js';

const KEY_REFRESH_POLL_MS = 60_000;
/** Minimum spacing between two well-known refresh attempts for one peer, shared by the
 *  inbound key-miss path and the proactive scheduler. */
const REFRESH_MIN_SPACING_MS = 30_000;
const DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

export interface WellKnownDoc {
  software?: string;
  protocolVersions: number[];
  rootKey: { ed25519: string };
  keys: SigningKeyCertificate[];
  [key: string]: unknown;
}

/** Stable classification for DNS/SRV discovery failures exposed to first-contact UI. */
export class FederationDomainResolutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FederationDomainResolutionError';
  }
}

interface CachedRoute {
  baseUrl: string;
  connectHost: string;
  fetchedAt: number;
  dispatcher?: Agent;
}

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);
  private readonly config = loadFederationConfig();
  private readonly routes = new Map<string, CachedRoute>();
  /** Single-flight well-known refreshes keyed by `<domain>#<namespaceId>`. */
  private readonly refreshInFlight = new Map<string, Promise<void>>();
  private readonly lastRefreshAttemptAt = new Map<string, number>();

  constructor(
    private readonly database: DatabaseService,
    private readonly keypair: KeypairService,
    private readonly httpScheduler: FederationHttpScheduler,
    private readonly transportConfig: FederationTransportConfigService,
  ) {}

  @Interval(KEY_REFRESH_POLL_MS)
  periodicRefresh(): void {
    void this.refreshDuePeers().catch((error) =>
      this.logger.warn(
        `proactive key-refresh round failed: ${(error as Error).message}`,
      ),
    );
  }

  /** Resolve the mandatory SOMFP SRV record while keeping the logical peer as HTTP/TLS authority. */
  async resolveBase(domain: string): Promise<string> {
    const normalized = this.normalizeDomain(domain);
    const ttlMs = this.transportConfig.get().keyCacheTtlSec * 1000;
    const cached = this.routes.get(normalized);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached.baseUrl;

    const devRoute = this.config.devRoutes[normalized];
    if (devRoute) {
      this.routes.set(normalized, {
        baseUrl: devRoute,
        connectHost: new URL(devRoute).hostname,
        fetchedAt: Date.now(),
      });
      return devRoute;
    }

    if (this.config.allowInsecureHttp) {
      const baseUrl = `http://${normalized}`;
      this.routes.set(normalized, {
        baseUrl,
        connectHost: normalized,
        fetchedAt: Date.now(),
      });
      return baseUrl;
    }

    let records;
    try {
      records = await resolveSrv(`_somfp._tcp.${normalized}`);
    } catch (error) {
      throw new FederationDomainResolutionError(
        `SRV discovery for ${normalized} failed`,
        { cause: error },
      );
    }
    if (records.length === 0)
      throw new FederationDomainResolutionError(
        `${normalized} does not publish SOMFP SRV`,
      );
    if (records.some((record) => record.name === '.')) {
      if (records.length === 1)
        throw new FederationDomainResolutionError(
          `${normalized} explicitly disables SOMFP`,
        );
      throw new FederationDomainResolutionError(
        `${normalized} publishes an invalid mixed SRV RRset`,
      );
    }
    const valid = records.filter(
      (record) =>
        DOMAIN_RE.test(record.name.replace(/\.+$/, '').toLowerCase()) &&
        record.port >= 1 &&
        record.port <= 65_535 &&
        record.priority >= 0 &&
        record.priority <= 65_535 &&
        record.weight >= 0 &&
        record.weight <= 65_535,
    );
    if (valid.length !== records.length)
      throw new FederationDomainResolutionError(
        `${normalized} publishes an invalid SOMFP SRV RRset`,
      );
    const priority = Math.min(...valid.map((record) => record.priority));
    const candidates = valid.filter((record) => record.priority === priority);
    const selected = this.weightedRecord(candidates);
    const connectHost = selected.name.replace(/\.+$/, '').toLowerCase();
    const baseUrl =
      selected.port === 443
        ? `https://${normalized}`
        : `https://${normalized}:${selected.port}`;
    const route: CachedRoute = {
      baseUrl,
      connectHost,
      fetchedAt: Date.now(),
    };
    route.dispatcher = this.createDispatcher(normalized, connectHost);
    this.routes.set(normalized, route);
    return baseUrl;
  }

  invalidateBase(domain: string): void {
    const normalized = this.normalizeDomain(domain);
    const route = this.routes.get(normalized);
    void route?.dispatcher?.close();
    this.routes.delete(normalized);
  }

  invalidateAllRoutes(): void {
    for (const route of this.routes.values()) void route.dispatcher?.close();
    this.routes.clear();
  }

  /** Federation HTTP transport: never follows redirects and preserves logical authority across SRV routing. */
  async request(url: URL | string, init: RequestInit = {}): Promise<Response> {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    const domain = this.normalizeDomain(parsed.hostname);
    const route = this.routes.get(domain);
    const response = await undiciFetch(parsed, {
      ...(init as Record<string, unknown>),
      redirect: 'manual',
      ...(route?.dispatcher ? { dispatcher: route.dispatcher } : {}),
    } as never);
    return response as unknown as Response;
  }

  /** Acquire an ordinary S2S HTTP slot. Callers acquire before signing/creating a timeout and release
   * after consuming the response. Media range downloads deliberately use their own scheduler. */
  acquireRequestSlot(peerDomain: string): Promise<() => void> {
    return this.httpScheduler.acquire(this.normalizeDomain(peerDomain));
  }

  async fetchWellKnown(domain: string): Promise<WellKnownDoc> {
    this.keypair.assertAvailable();
    const base = await this.resolveBase(domain);
    const release = await this.acquireRequestSlot(domain);
    try {
      const response = await this.request(`${base}/.well-known/somfp`, {
        signal: AbortSignal.timeout(
          this.transportConfig.get().callTimeoutSec * 1000,
        ),
        headers: { accept: 'application/json' },
      });
      if (response.status !== 200)
        throw new Error(`well-known ${domain}: HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!/^application\/json(?:\s*;|$)/i.test(contentType))
        throw new Error(`well-known ${domain}: invalid Content-Type`);
      let value: unknown;
      try {
        value = await response.json();
      } catch (error) {
        throw new Error(
          `well-known ${domain}: malformed JSON (${(error as Error).message})`,
        );
      }
      return this.validateWellKnown(domain, value);
    } finally {
      release();
    }
  }

  validateWellKnown(domain: string, value: unknown): WellKnownDoc {
    const normalized = this.normalizeDomain(domain);
    const doc = value as Partial<WellKnownDoc> | null;
    const softwareValid =
      doc?.software === undefined ||
      (typeof doc.software === 'string' &&
        Buffer.byteLength(doc.software) >= 1 &&
        Buffer.byteLength(doc.software) <= 128 &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(doc.software));
    if (
      !doc ||
      selectFederationProtocolVersion(doc.protocolVersions) !== 1 ||
      !softwareValid ||
      !doc.rootKey ||
      typeof doc.rootKey.ed25519 !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(doc.rootKey.ed25519) ||
      !Array.isArray(doc.keys) ||
      doc.keys.length === 0
    ) {
      throw new Error(`well-known ${normalized}: malformed v1 document`);
    }
    const ids = new Set<string>();
    for (const certificate of doc.keys) {
      if (
        !certificate ||
        typeof certificate.keyId !== 'string' ||
        parseKeyId(certificate.keyId)?.domain !== normalized ||
        ids.has(certificate.keyId) ||
        !verifySigningCertificate(certificate, doc.rootKey.ed25519)
      ) {
        throw new Error(
          `well-known ${normalized}: invalid signing certificate`,
        );
      }
      ids.add(certificate.keyId);
    }
    if (
      !doc.keys.some(
        (certificate) =>
          certificate.notBefore <= Date.now() &&
          Date.now() < certificate.notAfter,
      )
    ) {
      throw new Error(
        `well-known ${normalized}: no currently valid signing key`,
      );
    }
    return doc as WellKnownDoc;
  }

  async getPublicKey(
    domain: string,
    namespaceId: number,
    keyId: string,
  ): Promise<Uint8Array | null> {
    const normalized = this.normalizeDomain(domain);
    const cached = await this.cachedPublicKey(normalized, namespaceId, keyId);
    if (cached) return cached;
    // Non-Health key miss: single-flight, rate-limited well-known refresh, then
    // re-resolve from the atomically replaced cache set. A miss that survives the
    // refresh surfaces to the caller as FEDERATION_BAD_SIGNATURE (401); a fetch
    // failure propagates as the retryable key-fetch failure (503).
    await this.refreshPeerKeys(normalized, namespaceId);
    return this.cachedPublicKey(normalized, namespaceId, keyId);
  }

  private async cachedPublicKey(
    normalized: string,
    namespaceId: number,
    keyId: string,
  ): Promise<Uint8Array | null> {
    const now = new Date();
    const cached = await this.database.db.query.s2SKeyCache.findFirst({
      where: and(
        eq(tables.s2SKeyCache.domain, normalized),
        eq(tables.s2SKeyCache.namespaceId, namespaceId),
        eq(tables.s2SKeyCache.keyId, keyId),
      ),
    });
    return cached && cached.notBefore <= now && cached.notAfter > now
      ? Uint8Array.from(Buffer.from(cached.publicKey, 'base64'))
      : null;
  }

  /** Single-flight, rate-limited refresh of one peer's cached certificate set. Concurrent
   *  callers for the same pinned peer await one in-flight promise; the in-flight entry is
   *  cleared on both success and failure; the complete key set is replaced only after the
   *  document and root continuity have been validated. A skipped rate-limited attempt
   *  resolves without fetching. */
  async refreshPeerKeys(domain: string, namespaceId: number): Promise<void> {
    const normalized = this.normalizeDomain(domain);
    const scope = `${normalized}#${namespaceId}`;
    const inFlight = this.refreshInFlight.get(scope);
    if (inFlight) return inFlight;
    const lastAttempt = this.lastRefreshAttemptAt.get(scope) ?? 0;
    if (Date.now() - lastAttempt < REFRESH_MIN_SPACING_MS) return;
    const flight = (async () => {
      try {
        const doc = await this.fetchWellKnown(normalized);
        await this.cacheDocument(normalized, namespaceId, doc);
      } finally {
        this.lastRefreshAttemptAt.set(scope, Date.now());
        this.refreshInFlight.delete(scope);
      }
    })();
    this.refreshInFlight.set(scope, flight);
    return flight;
  }

  /** Proactive refresh scheduling: a peer is due when its cached certificate set has no
   *  current coverage, when the continuous coverage ends within the configured key-cache
   *  TTL window, or when the cached set is older than that TTL. Coverage is computed from
   *  the whole set — never from a guessed remote active key or only the largest notAfter. */
  async refreshDuePeers(): Promise<void> {
    if (!this.keypair.getStatus().available) return;
    const rows = await this.database.db
      .select({
        domain: tables.s2SKeyCache.domain,
        namespaceId: tables.s2SKeyCache.namespaceId,
        notBefore: tables.s2SKeyCache.notBefore,
        notAfter: tables.s2SKeyCache.notAfter,
        fetchedAt: tables.s2SKeyCache.fetchedAt,
      })
      .from(tables.s2SKeyCache);
    const now = Date.now();
    const ttlMs = this.transportConfig.get().keyCacheTtlSec * 1000;
    const byScope = new Map<
      string,
      {
        domain: string;
        namespaceId: number;
        intervals: CoverageInterval[];
        fetchedAt: number;
      }
    >();
    for (const row of rows) {
      const scope = `${row.domain}#${row.namespaceId}`;
      const entry = byScope.get(scope) ?? {
        domain: row.domain,
        namespaceId: row.namespaceId,
        intervals: [],
        fetchedAt: 0,
      };
      entry.intervals.push({
        notBefore: row.notBefore.getTime(),
        notAfter: row.notAfter.getTime(),
      });
      entry.fetchedAt = Math.max(entry.fetchedAt, row.fetchedAt.getTime());
      byScope.set(scope, entry);
    }
    for (const peer of byScope.values()) {
      const coverageEnd = continuousCoverageEnd(peer.intervals, now);
      const due =
        coverageEnd === null ||
        coverageEnd - now <= ttlMs ||
        now - peer.fetchedAt > ttlMs;
      if (due) {
        void this.refreshPeerKeys(peer.domain, peer.namespaceId).catch(
          (error) =>
            this.logger.warn(
              `proactive key refresh failed for ${peer.domain}: ${(error as Error).message}`,
            ),
        );
      }
    }
  }

  /** Maintenance hook after a successful outbound Health round trip: pull the peer's
   *  certificate set forward promptly when its coverage is about to end, without letting
   *  the refresh turn the successful Health result into a failure. */
  refreshAfterHealthSuccess(domain: string, namespaceId: number): void {
    void (async () => {
      try {
        const rows = await this.database.db
          .select({
            notBefore: tables.s2SKeyCache.notBefore,
            notAfter: tables.s2SKeyCache.notAfter,
          })
          .from(tables.s2SKeyCache)
          .where(
            and(
              eq(tables.s2SKeyCache.domain, this.normalizeDomain(domain)),
              eq(tables.s2SKeyCache.namespaceId, namespaceId),
            ),
          );
        const now = Date.now();
        const coverageEnd = continuousCoverageEnd(
          rows.map((row) => ({
            notBefore: row.notBefore.getTime(),
            notAfter: row.notAfter.getTime(),
          })),
          now,
        );
        const ttlMs = this.transportConfig.get().keyCacheTtlSec * 1000;
        if (coverageEnd !== null && coverageEnd - now > ttlMs) return;
        await this.refreshPeerKeys(domain, namespaceId);
      } catch (error) {
        this.logger.warn(
          `post-Health key refresh failed for ${domain}: ${(error as Error).message}`,
        );
      }
    })();
  }

  async getCachedPublicKey(
    domain: string,
    namespaceId: number,
    keyId: string,
  ): Promise<Uint8Array | null> {
    const now = new Date();
    const cached = await this.database.db.query.s2SKeyCache.findFirst({
      where: and(
        eq(tables.s2SKeyCache.domain, this.normalizeDomain(domain)),
        eq(tables.s2SKeyCache.namespaceId, namespaceId),
        eq(tables.s2SKeyCache.keyId, keyId),
      ),
    });
    return cached && cached.notBefore <= now && cached.notAfter > now
      ? Uint8Array.from(Buffer.from(cached.publicKey, 'base64'))
      : null;
  }

  /** Verify root continuity and atomically replace the cache with the currently published certificates. */
  async cacheDocument(
    domain: string,
    namespaceId: number,
    doc: WellKnownDoc,
  ): Promise<void> {
    const normalized = this.normalizeDomain(domain);
    const fingerprint = this.fingerprint(doc.rootKey.ed25519);
    const mismatch = await this.database.db.transaction(async (tx) => {
      const [peer] = await tx
        .select({
          activeNamespaceId: tables.federatedPeer.activeNamespaceId,
          rootPublicKey: tables.identityNamespace.rootPublicKey,
          rootKeyFingerprint: tables.identityNamespace.rootKeyFingerprint,
        })
        .from(tables.federatedPeer)
        .innerJoin(
          tables.identityNamespace,
          and(
            eq(tables.identityNamespace.domain, normalized),
            eq(tables.identityNamespace.id, namespaceId),
          ),
        )
        .where(eq(tables.federatedPeer.domain, normalized))
        .limit(1)
        // Lock a stable parent before replacing the key set. Concurrent DELETEs
        // can miss each other's newly inserted rows and then fail with 23505.
        .for('no key update', { of: tables.federatedPeer });
      if (
        !peer ||
        peer.rootPublicKey !== doc.rootKey.ed25519 ||
        peer.rootKeyFingerprint !== fingerprint
      ) {
        const reason =
          'peer presented a root different from the pinned identity';
        if (peer?.activeNamespaceId === namespaceId) {
          await tx
            .update(tables.federatedPeer)
            .set({
              trustLevel: 'halted',
              remoteServiceReachable: false,
              haltedAt: new Date(),
              haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
              haltReason: reason,
            })
            .where(eq(tables.federatedPeer.domain, normalized));
          await tx.insert(tables.federatedPeerEvent).values({
            domain: normalized,
            type: 'halted',
            reason,
          });
        }
        return reason;
      }
      await tx
        .delete(tables.s2SKeyCache)
        .where(eq(tables.s2SKeyCache.namespaceId, namespaceId));
      await tx.insert(tables.s2SKeyCache).values(
        doc.keys.map((key) => ({
          domain: normalized,
          namespaceId,
          keyId: key.keyId,
          publicKey: key.ed25519,
          notBefore: new Date(key.notBefore),
          notAfter: new Date(key.notAfter),
          authorizationSignature: key.authorizationSignature,
          fetchedAt: new Date(),
        })),
      );
      return undefined;
    });
    if (mismatch) {
      throw new BusinessException(
        BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        mismatch,
        HttpStatus.CONFLICT,
      );
    }
  }

  private weightedRecord<T extends { weight: number }>(records: T[]): T {
    const total = records.reduce((sum, record) => sum + record.weight, 0);
    if (total === 0)
      return records[Math.floor(Math.random() * records.length)]!;
    let selected = Math.random() * total;
    for (const record of records) {
      selected -= record.weight;
      if (selected < 0) return record;
    }
    return records[records.length - 1]!;
  }

  private createDispatcher(domain: string, connectHost: string): Agent {
    return new Agent({
      connectTimeout: this.transportConfig.get().connectTimeoutSec * 1000,
      connect: {
        servername: domain,
        lookup: (_hostname, options, callback) => {
          lookup(connectHost, options as never, (error, address, family) => {
            callback(
              error,
              address as string | LookupAddress[],
              family as number,
            );
          });
        },
      },
    });
  }

  private normalizeDomain(domain: string): string {
    const normalized = domain.trim().toLowerCase().replace(/\.+$/, '');
    if (!DOMAIN_RE.test(normalized))
      throw new Error(`invalid domain ${domain}`);
    return normalized;
  }

  private fingerprint(publicKey: string): string {
    return `sha256:${createHash('sha256')
      .update(Buffer.from(publicKey, 'base64'))
      .digest('base64url')}`;
  }
}
