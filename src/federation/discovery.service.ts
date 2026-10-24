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
import { loadFederationRuntimeConfig } from './federation.config.js';
import { continuousCoverageEnd } from './peer-key-coverage.js';
import { FederationTransportConfigService } from './federation-transport-config.service.js';
import { KeypairService } from './keypair.service.js';
import { FederationHttpScheduler } from './federation-http-scheduler.js';
import { classifySomfpSrvRrset } from './srv-rrset.js';
import { describeError } from '../logger/describe-error.js';
import {
  normalizeFederationDomain,
  validateWellKnownDocument,
  type WellKnownDoc,
} from './well-known-document.js';

export type { WellKnownDoc } from './well-known-document.js';

/** Minimum spacing between two well-known refresh attempts for one peer, shared by
 *  the inbound key-miss path and the maintenance entry point. */
const REFRESH_MIN_SPACING_MS = 30_000;

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
  connectTimeoutMs?: number;
  dispatcher?: Agent;
}

@Injectable()
export class DiscoveryService implements OnApplicationShutdown {
  private readonly logger = new Logger(DiscoveryService.name);
  private readonly config = loadFederationRuntimeConfig();
  private readonly routes = new Map<string, CachedRoute>();
  private readonly routeBuilds = new Map<string, Promise<string>>();
  private readonly retiring = new Map<Agent, Promise<void>>();
  private readonly poolCancellation = new WeakMap<Agent, AbortController>();
  private stopping = false;
  /** Single-flight well-known refreshes keyed by `<domain>#<namespaceId>`. */
  private readonly refreshInFlight = new Map<string, Promise<void>>();
  private readonly lastRefreshAttemptAt = new Map<string, number>();

  constructor(
    private readonly database: DatabaseService,
    private readonly keypair: KeypairService,
    private readonly httpScheduler: FederationHttpScheduler,
    private readonly transportConfig: FederationTransportConfigService,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.invalidateAllRoutes();
    await Promise.all(this.retiring.values());
  }

  /** Resolve the mandatory SOMFP SRV record while keeping the logical peer as HTTP/TLS authority.
   *  The route is cached in memory and refreshed explicitly by {@link refreshRoute}; there is no
   *  lazy TTL. {@link refreshRoute} is driven by the Health round so SRV changes propagate at the
   *  Health cadence without every request re-querying DNS. */
  async resolveBase(domain: string): Promise<string> {
    const normalized = this.normalizeDomain(domain);
    this.assertRunning();
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
      await this.buildRoute(normalized);
    } catch (error) {
      if (!this.routes.has(normalized)) throw error;
      this.logger.warn({
        msg: `SRV refresh for ${normalized} failed, keeping cached route`,
        error: describeError(error),
      });
    }
  }

  /** Coalesce DNS lookups. Invalidating a route detaches its pending lookup so an
   *  obsolete result cannot publish a route or allocate a new Agent. */
  private buildRoute(normalized: string): Promise<string> {
    this.assertRunning();
    const pending = this.routeBuilds.get(normalized);
    if (pending) return pending;
    const build = Promise.resolve().then(() =>
      this.discoverRoute(normalized, () => {
        this.assertRunning();
        if (this.routeBuilds.get(normalized) !== build)
          throw new Error(
            `Federation route lookup invalidated for ${normalized}`,
          );
      }),
    );
    this.routeBuilds.set(normalized, build);
    const cleanup = () => {
      if (this.routeBuilds.get(normalized) === build)
        this.routeBuilds.delete(normalized);
    };
    void build.then(cleanup, cleanup);
    return build;
  }

  private async discoverRoute(
    normalized: string,
    assertCurrent: () => void,
  ): Promise<string> {
    assertCurrent();
    if (this.config.allowInsecureHttp) {
      const baseUrl = `http://${normalized}`;
      this.publishRoute(normalized, {
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
    assertCurrent();
    const rrset = classifySomfpSrvRrset(records);
    if (rrset.kind === 'empty')
      throw new FederationDomainResolutionError(
        `${normalized} does not publish SOMFP SRV`,
      );
    if (rrset.kind === 'disabled')
      throw new FederationDomainResolutionError(
        `${normalized} explicitly disables SOMFP`,
      );
    if (rrset.kind === 'invalid')
      throw new FederationDomainResolutionError(
        rrset.reason === 'mixed'
          ? `${normalized} publishes an invalid mixed SRV RRset`
          : `${normalized} publishes an invalid SOMFP SRV RRset`,
      );
    const priority = Math.min(
      ...rrset.records.map((record) => record.priority),
    );
    const candidates = rrset.records.filter(
      (record) => record.priority === priority,
    );
    const selected = this.weightedRecord(candidates);
    const connectHost = selected.host;
    const baseUrl =
      selected.port === 443
        ? `https://${normalized}`
        : `https://${normalized}:${selected.port}`;
    const previous = this.routes.get(normalized);
    const connectTimeoutMs =
      this.transportConfig.get().connectTimeoutSec * 1000;
    // Reuse the previous dispatcher when the connect target is unchanged so the
    // keep-alive pool stays warm across Health-driven SRV refreshes.
    const dispatcher =
      previous &&
      previous.connectHost === connectHost &&
      previous.baseUrl === baseUrl &&
      previous.connectTimeoutMs === connectTimeoutMs
        ? previous.dispatcher
        : this.createDispatcher(normalized, connectHost, connectTimeoutMs);
    const route: CachedRoute = {
      baseUrl,
      connectHost,
      fetchedAt: Date.now(),
      connectTimeoutMs,
      dispatcher,
    };
    this.publishRoute(normalized, route);
    return baseUrl;
  }

  private assertRunning(): void {
    if (this.stopping) throw new Error('Federation transport is shutting down');
  }

  private publishRoute(domain: string, route: CachedRoute): void {
    const previous = this.routes.get(domain);
    this.routes.set(domain, route);
    if (previous?.dispatcher && previous.dispatcher !== route.dispatcher)
      this.retire(previous.dispatcher);
  }

  /** Undici drains already dispatched requests, including response bodies, on close.
   *  Bound draining so an abandoned streaming body cannot leak a retired pool forever. */
  private retire(agent: Agent): void {
    if (this.retiring.has(agent)) return;
    const draining = (async () => {
      const timeoutMs = Math.max(
        1_000,
        (this.transportConfig.get().callTimeoutSec ?? 30) * 1000,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const closed = await Promise.race([
          agent.close().then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
            timer.unref();
          }),
        ]);
        if (!closed) {
          this.logger.warn(
            'Federation HTTP pool drain timed out; destroying remaining connections',
          );
          // Agent.close detaches its child pools in Undici. Cancel active fetches
          // explicitly rather than relying on Agent.destroy to find those pools.
          this.poolCancellation
            .get(agent)
            ?.abort(new Error('Federation pool drain timed out'));
          await agent.destroy();
        }
      } catch (error) {
        this.logger.warn({
          msg: 'Failed to drain federation HTTP pool',
          error: describeError(error),
        });
        try {
          this.poolCancellation
            .get(agent)
            ?.abort(new Error('Federation pool drain failed'));
          await agent.destroy();
        } catch (destroyError) {
          this.logger.warn({
            msg: 'Failed to destroy federation HTTP pool',
            error: describeError(destroyError),
          });
        }
      } finally {
        clearTimeout(timer);
      }
    })();
    this.retiring.set(agent, draining);
    void draining.then(() => this.retiring.delete(agent));
  }

  invalidateBase(domain: string): void {
    const normalized = this.normalizeDomain(domain);
    const route = this.routes.get(normalized);
    this.routeBuilds.delete(normalized);
    this.routes.delete(normalized);
    if (route?.dispatcher) this.retire(route.dispatcher);
  }

  invalidateAllRoutes(): void {
    this.routeBuilds.clear();
    const previous = [...this.routes.values()];
    this.routes.clear();
    for (const route of previous)
      if (route.dispatcher) this.retire(route.dispatcher);
  }

  /** Federation HTTP transport: never follows redirects and preserves logical authority across SRV routing. */
  async request(url: URL | string, init: RequestInit = {}): Promise<Response> {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    const domain = this.normalizeDomain(parsed.hostname);
    await this.resolveBase(domain);
    this.assertRunning();
    const route = this.routes.get(domain);
    // Never silently fall back to apex DNS after invalidation, or dispatch to an
    // obsolete port after a concurrent refresh. The caller must resolve again.
    if (!route || new URL(route.baseUrl).origin !== parsed.origin)
      throw new Error(`Federation route changed before dispatch for ${domain}`);
    const poolSignal = route.dispatcher
      ? this.poolCancellation.get(route.dispatcher)?.signal
      : undefined;
    const response = await undiciFetch(parsed, {
      ...(init as Record<string, unknown>),
      ...(poolSignal
        ? {
            signal: init.signal
              ? AbortSignal.any([init.signal, poolSignal])
              : poolSignal,
          }
        : {}),
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

  /** Peer-side document validation, shared with the admin self-check. */
  validateWellKnown(domain: string, value: unknown): WellKnownDoc {
    return validateWellKnownDocument(domain, value);
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
    const refreshWindowMs = this.transportConfig.get().keyCacheTtlSec * 1000;
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

  private createDispatcher(
    domain: string,
    connectHost: string,
    connectTimeoutMs: number,
  ): Agent {
    const agent = new Agent({
      connectTimeout: connectTimeoutMs,
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
    this.poolCancellation.set(agent, new AbortController());
    return agent;
  }

  private normalizeDomain(domain: string): string {
    return normalizeFederationDomain(domain);
  }
}
