import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { resolveSrv } from 'node:dns/promises';
import { and, eq } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { loadFederationConfig } from './federation.config.js';
import { KeypairService } from './keypair.service.js';

/** Proactive peer-key refresh cadence — equals the lazy cache TTL (SOMS_KEY_CACHE_TTL_SEC, 6h default).
 *  Read directly from env, NOT via loadFederationConfig, so evaluating it at module scope never triggers
 *  the fail-fast requireEnv('SOMS_DOMAIN') at import time (test harnesses import this module before SOMS_DOMAIN
 *  is set). Numerically identical to loadFederationConfig().keyCacheTtlSec * 1000. */
const KEY_REFRESH_MS =
  Number(process.env.SOMS_KEY_CACHE_TTL_SEC ?? 6 * 60 * 60) * 1000;

interface PeerKey {
  keyId: string;
  ed25519: string; // base64 raw 32 bytes
}
export interface WellKnownDoc {
  software?: string;
  protocolVersion?: number;
  identityEpoch?: number;
  rootKey?: { fingerprint?: string; ed25519?: string };
  keys: PeerKey[];
}

/**
 * Resolves peer servers: SRV `_soms._tcp.<domain>` (host:port, fallback https://<domain>) → fetch
 * `.well-known/soms` over HTTPS → cache the peer's single identity/signing key.
 *
 * Key cache: fetch-on-`keyId`-miss + TTL. A proactive refresh worker re-fetches every
 * communicated-with peer's key each TTL window. A pinned peer may never replace or add a key.
 * No eviction in v0.1 — the cache only ever holds trusted peers (the allow-list gate at Gate 1
 * precedes any key fetch, so untrusted senders never populate it; the set is small + admin-managed).
 *
 * Step-1 simplifications (documented): the `.well-known` fetch uses native fetch (Node HE handles
 * v4/v6); the explicit RFC 8305 racing (§6.4) lands with the shared S2S HTTP client in Phase D.
 *
 * Error contract: fetch failures THROW (caller returns 503 → sender retries). A transient key fetch
 * must NEVER become a permanent 401 — that would violate §6.1's "401 = do not retry".
 */
@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);
  private readonly config = loadFederationConfig();
  private readonly baseCache = new Map<
    string,
    { baseUrl: string; fetchedAt: number }
  >();

  constructor(
    private readonly database: DatabaseService,
    private readonly keypair: KeypairService,
  ) {}

  /** Proactive peer-key refresh round. Registered with @nestjs/schedule; cleared on shutdown. */
  @Interval(KEY_REFRESH_MS)
  periodicRefresh(): void {
    this.refreshAll().catch((e) =>
      this.logger.warn(
        `proactive key-refresh round failed: ${(e as Error).message}`,
      ),
    );
  }

  /** Resolve a peer's base URL via SRV `_soms._tcp.<domain>` (fallback to apex), in-memory cached. */
  async resolveBase(domain: string): Promise<string> {
    const ttlMs = this.config.keyCacheTtlSec * 1000;
    const cached = this.baseCache.get(domain);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached.baseUrl;

    let host = domain;
    let port: number | undefined;
    try {
      const records = await resolveSrv(`_soms._tcp.${domain}`);
      if (records.length > 0) {
        // Step-1: take the highest-priority target. (Full priority/weight selection per RFC 2782 §6.4 Layer 2.)
        records.sort((a, b) => a.priority - b.priority || a.weight - b.weight);
        const top = records[0];
        host = top.name.replace(/\.+$/, ''); // strip trailing FQDN dot
        port = top.port;
      }
    } catch (e) {
      // No SRV record (ENOTFOUND) or DNS hiccup → fall back to the apex domain; the .well-known
      // fetch below is the real liveness test.
      this.logger.debug(
        `SRV _soms._tcp.${domain} fell back to apex: ${(e as Error).message}`,
      );
    }

    const scheme = this.config.allowInsecureHttp ? 'http' : 'https';
    const defaultPort = scheme === 'https' ? 443 : 80;
    const baseUrl =
      port && port !== defaultPort
        ? `${scheme}://${host}:${port}`
        : `${scheme}://${host}`;
    this.baseCache.set(domain, { baseUrl, fetchedAt: Date.now() });
    return baseUrl;
  }

  /** GET `<domain>/.well-known/soms` with the S2S call timeout. Throws on non-2xx or malformed shape. */
  async fetchWellKnown(domain: string): Promise<WellKnownDoc> {
    this.keypair.assertAvailable();
    const base = await this.resolveBase(domain);
    const res = await fetch(`${base}/.well-known/soms`, {
      signal: AbortSignal.timeout(this.config.callTimeoutSec * 1000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`well-known ${domain}: HTTP ${res.status}`);
    let doc: WellKnownDoc;
    try {
      doc = (await res.json()) as WellKnownDoc;
    } catch (e) {
      throw new Error(
        `well-known ${domain}: malformed JSON (${(e as Error).message})`,
      );
    }
    if (!doc || !Array.isArray(doc.keys)) {
      throw new Error(`well-known ${domain}: missing keys`);
    }
    return doc;
  }

  /**
   * Resolve a peer's public key by keyId: TTL-cached in S2SKeyCache, fetch-on-miss from .well-known.
   * THROWS on fetch failure (caller → 503 → sender retries). Returns null only if the peer is
   * reachable but does not publish this keyId (a permanent signature failure → caller 401).
   */
  async getPublicKey(
    domain: string,
    keyId: string,
  ): Promise<Uint8Array | null> {
    const ttlMs = this.config.keyCacheTtlSec * 1000;
    const cached = await this.database.db.query.s2SKeyCache.findFirst({
      where: and(
        eq(tables.s2SKeyCache.domain, domain),
        eq(tables.s2SKeyCache.keyId, keyId),
      ),
    });
    if (cached && Date.now() - cached.fetchedAt.getTime() < ttlMs) {
      return Uint8Array.from(Buffer.from(cached.publicKey, 'base64'));
    }
    // Cache miss or stale → re-fetch the peer's single published key.
    const doc = await this.fetchWellKnown(domain); // throws → caller 503
    await this.cacheKeys(domain, doc.keys);
    const hit = doc.keys.find((k) => k.keyId === keyId);
    return hit ? Uint8Array.from(Buffer.from(hit.ed25519, 'base64')) : null;
  }

  /**
   * Cache a peer's single key. Once identity is pinned, a different keyId or different public key is
   * identity loss, never a cache refresh. The old cache row is deliberately retained as evidence.
   */
  async cacheKeys(domain: string, keys: PeerKey[]): Promise<void> {
    const normalized = domain.trim().toLowerCase().replace(/\.+$/, '');
    if (
      keys.length === 0 ||
      keys.some(
        (candidate) =>
          candidate.keyId.split('/')[0] !== normalized ||
          !/^[A-Za-z0-9+/]{43}=$/.test(candidate.ed25519),
      )
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_IDENTITY_PROOF_INVALID,
        `${normalized} must publish exactly one valid domain-bound key`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const key = keys[0];
    const mismatchReason = await this.database.db.transaction(async (tx) => {
      const [peer, cachedKeys] = await Promise.all([
        tx.query.federatedPeer.findFirst({
          where: eq(tables.federatedPeer.domain, normalized),
        }),
        tx.query.s2SKeyCache.findMany({
          where: eq(tables.s2SKeyCache.domain, normalized),
        }),
      ]);
      const pinned = peer?.identityPinnedAt != null;
      if (!pinned && keys.length !== 1) {
        throw new BusinessException(
          BusinessCode.FEDERATION_IDENTITY_PROOF_INVALID,
          `${normalized} must publish exactly one key`,
          HttpStatus.UNAUTHORIZED,
        );
      }
      const cached = cachedKeys.find((row) => row.keyId === key.keyId);
      const mismatch =
        keys.length !== 1 ||
        (cached && cached.publicKey !== key.ed25519) ||
        (pinned &&
          (cachedKeys.length !== 1 ||
            !cached ||
            cached.publicKey !== key.ed25519));
      if (mismatch) {
        const reason = 'peer replaced its pinned federation signing key';
        if (
          peer?.trustLevel !== 'identity_lost' &&
          peer?.trustLevel !== 'reset_in_progress'
        ) {
          await tx
            .update(tables.federatedPeer)
            .set({
              trustLevel: 'identity_lost',
              identityLostAt: new Date(),
              identityLostReason: reason,
            })
            .where(eq(tables.federatedPeer.domain, normalized));
          await tx.insert(tables.federatedPeerEvent).values({
            domain: normalized,
            type: 'identity_lost',
            reason,
          });
        }
        return reason;
      }
      const fetchedAt = new Date();
      await tx
        .insert(tables.s2SKeyCache)
        .values({
          domain: normalized,
          keyId: key.keyId,
          publicKey: key.ed25519,
          fetchedAt,
        })
        .onConflictDoUpdate({
          target: [tables.s2SKeyCache.domain, tables.s2SKeyCache.keyId],
          set: { fetchedAt },
        });
      return undefined;
    });
    if (mismatchReason) {
      throw new BusinessException(
        BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        mismatchReason,
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Proactive refresh: re-fetch every cached peer's keys. Per-domain failures are logged, not fatal. */
  private async refreshAll(): Promise<void> {
    if (!this.keypair.getStatus().available) return;
    const rows = await this.database.db
      .selectDistinct({ domain: tables.s2SKeyCache.domain })
      .from(tables.s2SKeyCache);
    for (const { domain } of rows) {
      try {
        const doc = await this.fetchWellKnown(domain);
        await this.cacheKeys(domain, doc.keys);
      } catch (e) {
        this.logger.warn(
          `proactive key refresh failed for ${domain}: ${(e as Error).message}`,
        );
      }
    }
  }
}
