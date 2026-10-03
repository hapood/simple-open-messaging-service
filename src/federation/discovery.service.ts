import {
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { lookup, type LookupAddress } from 'node:dns';
import { resolveSrv } from 'node:dns/promises';
import { and, eq } from 'drizzle-orm';
import { Agent, fetch as undiciFetch } from 'undici';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import {
  isValidRootKeyEntry,
  type RootKeyEntry,
  type SigningKeyCertificate,
  verifySigningCertificate,
} from './federation-certificate.js';
import { loadFederationConfig } from './federation.config.js';
import { parseKeyId } from './key-id.js';
import {
  continuousCoverageEnd,
} from './peer-key-coverage.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';
import { KeypairService } from './keypair.service.js';
import { selectFederationProtocolVersion } from './federation-protocol.js';
import { FederationHttpScheduler } from './federation-http-scheduler.js';

/** Minimum spacing between two well-known refresh attempts for one peer, shared by the
 *  inbound key-miss path and the maintenance entry point. */
const REFRESH_MIN_SPACING_MS = 30_000;
const DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

export interface WellKnownDoc {
  software?: string;
  protocolVersions: number[];
  roots: RootKeyEntry[];
  keys: SigningKeyCertificate[];
  [key: string]: unknown;
}

/** The root a first-contact Recognize pins: the root authorizing a currently
 *  valid certificate. A B-mode rotation leaves exactly one such root; a group
 *  with several is resolved to the root of the certificate actually signing
 *  the request, which the recognition flow extracts itself. */
export function currentCertifyingRoots(doc: WellKnownDoc): string[] {
  const now = Date.now();
  const roots = new Set<string>();
  for (const certificate of doc.keys) {
    if (certificate.notBefore <= now && now < certificate.notAfter)
      roots.add(certificate.root);
  }
  return [...roots];
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
export class DiscoveryService implements OnApplicationShutdown {
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

  onApplicationShutdown(): void {
    this.invalidateAllRoutes();
  }

  /** Resolve the mandatory SOMFP SRV record while keeping the logical peer as HTTP/TLS authority.
   *  The route is cached in memory and refreshed explicitly by {@link refreshRoute}; there is no
   *  lazy TTL. {@link refreshRoute} is driven by the Health round so SRV changes propagate at the
   *  Health cadence without every request re-querying DNS. */
  async resolveBase(domain: string): Promise<string> {
    const normalized = this.normalizeDomain(domain);
    const cached = this.routes.get(normalized);
    if (cached) return cached.baseUrl;
    return this.buildRoute(normalized);
  }

  /** Force a fresh SRV lookup for one peer, replacing the cached route (and its connection
   *  pool) when the published target changes. Called by the Health round so SRV edits land at
   *  the Health cadence. A failed lookup leaves the previous route in place when one exists. */
  async refreshRoute(domain: string): Promise<void> {
    const normalized = this.normalizeDomain(domain);
    try {
      await this.buildRoute(normalized, /* replace */ true);
    } catch (error) {
      if (!this.routes.has(normalized)) throw error;
      this.logger.warn(
        `SRV refresh for ${normalized} failed, keeping cached route: ${(error as Error).message}`,
      );
    }
  }

  /** Build (or rebuild) the cached route. When `replace` is set and the SRV target changed,
   *  the previous dispatcher is closed so its connection pool is reclaimed. */
  private async buildRoute(
    normalized: string,
    replace = false,
  ): Promise<string> {
    const devRoute = this.config.devRoutes[normalized];
    if (devRoute) {
      this.maybeClosePreviousDispatcher(normalized, replace);
      this.routes.set(normalized, {
        baseUrl: devRoute,
        connectHost: new URL(devRoute).hostname,
        fetchedAt: Date.now(),
      });
      return devRoute;
    }

    if (this.config.allowInsecureHttp) {
      this.maybeClosePreviousDispatcher(normalized, replace);
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
    const previous = replace ? this.routes.get(normalized) : undefined;
    // Reuse the previous dispatcher when the connect target is unchanged so the
    // keep-alive pool stays warm across Health-driven SRV refreshes.
    const dispatcher =
      previous && previous.connectHost === connectHost
        ? previous.dispatcher
        : this.createDispatcher(normalized, connectHost);
    this.maybeClosePreviousDispatcher(normalized, replace, previous);
    const route: CachedRoute = {
      baseUrl,
      connectHost,
      fetchedAt: Date.now(),
      dispatcher,
    };
    this.routes.set(normalized, route);
    return baseUrl;
  }

  private maybeClosePreviousDispatcher(
    normalized: string,
    replace: boolean,
    previous: CachedRoute | undefined = this.routes.get(normalized),
  ): void {
    if (replace && previous?.dispatcher) void previous.dispatcher.close();
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
    const now = Date.now();
    if (
      !doc ||
      selectFederationProtocolVersion(doc.protocolVersions) !== 1 ||
      !softwareValid ||
      !Array.isArray(doc.roots) ||
      doc.roots.length === 0 ||
      !Array.isArray(doc.keys) ||
      doc.keys.length === 0
    ) {
      throw new Error(`well-known ${normalized}: malformed v1 document`);
    }
    // Root group: unique canonical keys, sane intervals, and at least one
    // currently valid root when the document is consumed.
    const rootEntries = new Map<string, RootKeyEntry>();
    for (const entry of doc.roots) {
      if (!isValidRootKeyEntry(entry) || rootEntries.has(entry.ed25519)) {
        throw new Error(`well-known ${normalized}: invalid roots group`);
      }
      rootEntries.set(entry.ed25519, entry);
    }
    if (
      ![...rootEntries.values()].some(
        (entry) => entry.notBefore <= now && now < entry.notAfter,
      )
    ) {
      throw new Error(`well-known ${normalized}: no currently valid root`);
    }
    const ids = new Set<string>();
    for (const certificate of doc.keys) {
      const authorizing = rootEntries.get(certificate?.root as string);
      if (
        !certificate ||
        typeof certificate.keyId !== 'string' ||
        parseKeyId(certificate.keyId)?.domain !== normalized ||
        ids.has(certificate.keyId) ||
        !authorizing ||
        // The certificate interval must be enclosed by its root's interval.
        certificate.notBefore < authorizing.notBefore ||
        certificate.notAfter > authorizing.notAfter ||
        !verifySigningCertificate(certificate, certificate.root)
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

  /** Read-only cached-key lookup used by the inbound signature path. A miss is NOT
   *  repaired here: certificate freshness is owned by the Health round (and by the
   *  Recognize bootstrap, which fetches before first use). A missing or expired
   *  certificate surfaces to the caller as a 401 FEDERATION_BAD_SIGNATURE, which is
   *  the protocol-correct outcome for an unpublished keyId; a key the peer rotated to
   *  but the local cache has not yet adopted is filled by the next Health refresh. */
  async getPublicKey(
    domain: string,
    namespaceId: number,
    keyId: string,
  ): Promise<Uint8Array | null> {
    return this.cachedPublicKey(
      this.normalizeDomain(domain),
      namespaceId,
      keyId,
    );
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
    // A cached certificate authenticates only while it is currently valid AND
    // its authorizing root still byte-equals the namespace pin: successor-root
    // certificates of a rotation pending local adoption must not authenticate.
    if (
      !cached ||
      !(cached.notBefore <= now && cached.notAfter > now) ||
      !(await this.rootMatchesPin(namespaceId, cached.root))
    ) {
      return null;
    }
    return Uint8Array.from(Buffer.from(cached.publicKey, 'base64'));
  }

  private async rootMatchesPin(
    namespaceId: number,
    root: string,
  ): Promise<boolean> {
    const [namespace] = await this.database.db
      .select({ rootPublicKey: tables.identityNamespace.rootPublicKey })
      .from(tables.identityNamespace)
      .where(eq(tables.identityNamespace.id, namespaceId))
      .limit(1);
    return namespace?.rootPublicKey === root;
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

  /** Coverage-based certificate refresh gate, driven by the Health round. Returns true when a
   *  well-known refresh was started (or already in flight) for this peer. A peer is due when its
   *  cached certificate set has no current coverage, or the continuous coverage ends within the
   *  configured refresh window. Coverage is computed from the whole set keyed by namespace — never
   *  from a guessed remote active key or only the largest notAfter. Maintenance only: the caller's
   *  Health result stands regardless of the returned promise. */
  async refreshPeerCertificateIfNeeded(
    domain: string,
    namespaceId: number,
  ): Promise<boolean> {
    const normalized = this.normalizeDomain(domain);
    const scope = `${normalized}#${namespaceId}`;
    if (this.refreshInFlight.has(scope)) return true;
    const lastAttempt = this.lastRefreshAttemptAt.get(scope) ?? 0;
    if (Date.now() - lastAttempt < REFRESH_MIN_SPACING_MS) return false;
    const rows = await this.database.db
      .select({
        notBefore: tables.s2SKeyCache.notBefore,
        notAfter: tables.s2SKeyCache.notAfter,
      })
      .from(tables.s2SKeyCache)
      .where(eq(tables.s2SKeyCache.namespaceId, namespaceId));
    const now = Date.now();
    const coverageEnd = continuousCoverageEnd(
      rows.map((row) => ({
        notBefore: row.notBefore.getTime(),
        notAfter: row.notAfter.getTime(),
      })),
      now,
    );
    const refreshWindowMs =
      this.transportConfig.get().keyCacheTtlSec * 1000;
    if (coverageEnd !== null && coverageEnd - now > refreshWindowMs)
      return false;
    void this.refreshPeerKeys(normalized, namespaceId).catch((error) =>
      this.logger.warn(
        `certificate refresh failed for ${normalized}: ${(error as Error).message}`,
      ),
    );
    return true;
  }

  async getCachedPublicKey(
    domain: string,
    namespaceId: number,
    keyId: string,
  ): Promise<Uint8Array | null> {
    return this.cachedPublicKey(
      this.normalizeDomain(domain),
      namespaceId,
      keyId,
    );
  }

  /** Verify root-group continuity and atomically replace the cache with the
   *  published certificates. The pinned root MUST still be present in the
   *  fetched roots group byte for byte: a peer may add successor roots
   *  (rotation pending adoption) but dropping the pin is an identity
   *  contradiction, not rotation. Certificates authorized by other roots in
   *  the group are cached too; the guard only authenticates those whose root
   *  byte-equals the pin. */
  async cacheDocument(
    domain: string,
    namespaceId: number,
    doc: WellKnownDoc,
  ): Promise<void> {
    const normalized = this.normalizeDomain(domain);
    const mismatch = await this.database.db.transaction(async (tx) => {
      const [namespace] = await tx
        .select({
          domain: tables.identityNamespace.domain,
          active: tables.identityNamespace.active,
          rootPublicKey: tables.identityNamespace.rootPublicKey,
        })
        .from(tables.identityNamespace)
        .where(eq(tables.identityNamespace.id, namespaceId))
        .limit(1)
        // Lock the pinned identity row before replacing the key set. Concurrent
        // DELETEs can miss each other's newly inserted rows and then fail with 23505.
        .for('no key update', { of: tables.identityNamespace });
      const pinStillPublished =
        namespace?.rootPublicKey !== undefined &&
        doc.roots.some((entry) => entry.ed25519 === namespace.rootPublicKey);
      if (!namespace || namespace.domain !== normalized || !pinStillPublished) {
        const reason =
          'peer presented a root different from the pinned identity';
        if (namespace?.active && namespace.domain === normalized) {
          await tx
            .update(tables.identityNamespace)
            .set({
              trustLevel: 'halted',
              remoteServiceReachable: false,
              haltedAt: new Date(),
              haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
              haltReason: reason,
            })
            .where(eq(tables.identityNamespace.id, namespaceId));
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
          root: key.root,
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
}
