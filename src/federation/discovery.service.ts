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
  certificateDomain,
  type SigningKeyCertificate,
  verifySigningCertificate,
} from './federation-certificate.js';
import { loadFederationConfig } from './federation.config.js';
import { KeypairService } from './keypair.service.js';
import { selectFederationProtocolVersion } from './federation-protocol.js';

const KEY_REFRESH_MS =
  Number(process.env.SOMS_KEY_CACHE_TTL_SEC ?? 6 * 60 * 60) * 1000;
const DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

export interface WellKnownDoc {
  software?: string;
  protocolVersions: number[];
  rootKey: { ed25519: string };
  keys: SigningKeyCertificate[];
  [key: string]: unknown;
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

  constructor(
    private readonly database: DatabaseService,
    private readonly keypair: KeypairService,
  ) {}

  @Interval(KEY_REFRESH_MS)
  periodicRefresh(): void {
    void this.refreshAll().catch((error) =>
      this.logger.warn(
        `proactive key-refresh round failed: ${(error as Error).message}`,
      ),
    );
  }

  /** Resolve the mandatory SOMS SRV record while keeping the logical peer as HTTP/TLS authority. */
  async resolveBase(domain: string): Promise<string> {
    const normalized = this.normalizeDomain(domain);
    const ttlMs = this.config.keyCacheTtlSec * 1000;
    const cached = this.routes.get(normalized);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached.baseUrl;

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
      records = await resolveSrv(`_soms._tcp.${normalized}`);
    } catch (error) {
      throw new Error(
        `SRV discovery for ${normalized} failed: ${(error as Error).message}`,
      );
    }
    if (records.length === 0)
      throw new Error(`${normalized} does not publish SOMS Federation SRV`);
    if (records.some((record) => record.name === '.')) {
      if (records.length === 1)
        throw new Error(`${normalized} explicitly disables SOMS Federation`);
      throw new Error(`${normalized} publishes an invalid mixed SRV RRset`);
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
      throw new Error(`${normalized} publishes an invalid SOMS SRV RRset`);
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

  async fetchWellKnown(domain: string): Promise<WellKnownDoc> {
    this.keypair.assertAvailable();
    const base = await this.resolveBase(domain);
    const response = await this.request(`${base}/.well-known/soms`, {
      signal: AbortSignal.timeout(this.config.callTimeoutSec * 1000),
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
        certificateDomain(certificate.keyId) !== normalized ||
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
    keyId: string,
  ): Promise<Uint8Array | null> {
    const normalized = this.normalizeDomain(domain);
    const now = new Date();
    const cached = await this.database.db.query.s2SKeyCache.findFirst({
      where: and(
        eq(tables.s2SKeyCache.domain, normalized),
        eq(tables.s2SKeyCache.keyId, keyId),
      ),
    });
    if (cached && cached.notBefore <= now && cached.notAfter > now) {
      return Uint8Array.from(Buffer.from(cached.publicKey, 'base64'));
    }
    const doc = await this.fetchWellKnown(normalized);
    await this.cacheDocument(normalized, doc);
    const hit = doc.keys.find(
      (key) =>
        key.keyId === keyId &&
        key.notBefore <= Date.now() &&
        Date.now() < key.notAfter,
    );
    return hit ? Uint8Array.from(Buffer.from(hit.ed25519, 'base64')) : null;
  }

  async getCachedPublicKey(
    domain: string,
    keyId: string,
  ): Promise<Uint8Array | null> {
    const now = new Date();
    const cached = await this.database.db.query.s2SKeyCache.findFirst({
      where: and(
        eq(tables.s2SKeyCache.domain, this.normalizeDomain(domain)),
        eq(tables.s2SKeyCache.keyId, keyId),
      ),
    });
    return cached && cached.notBefore <= now && cached.notAfter > now
      ? Uint8Array.from(Buffer.from(cached.publicKey, 'base64'))
      : null;
  }

  /** Verify root continuity and atomically replace the cache with the currently published certificates. */
  async cacheDocument(domain: string, doc: WellKnownDoc): Promise<void> {
    const normalized = this.normalizeDomain(domain);
    const fingerprint = this.fingerprint(doc.rootKey.ed25519);
    const mismatch = await this.database.db.transaction(async (tx) => {
      const peer = await tx.query.federatedPeer.findFirst({
        where: eq(tables.federatedPeer.domain, normalized),
      });
      if (
        peer?.identityPinnedAt &&
        (peer.rootPublicKey !== doc.rootKey.ed25519 ||
          peer.rootKeyFingerprint !== fingerprint)
      ) {
        const reason =
          'peer presented a root different from the pinned identity';
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
        return reason;
      }
      await tx
        .delete(tables.s2SKeyCache)
        .where(eq(tables.s2SKeyCache.domain, normalized));
      await tx.insert(tables.s2SKeyCache).values(
        doc.keys.map((key) => ({
          domain: normalized,
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

  private async refreshAll(): Promise<void> {
    if (!this.keypair.getStatus().available) return;
    const rows = await this.database.db
      .selectDistinct({ domain: tables.s2SKeyCache.domain })
      .from(tables.s2SKeyCache);
    for (const { domain } of rows) {
      try {
        const doc = await this.fetchWellKnown(domain);
        await this.cacheDocument(domain, doc);
      } catch (error) {
        this.logger.warn(
          `proactive key refresh failed for ${domain}: ${(error as Error).message}`,
        );
      }
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
