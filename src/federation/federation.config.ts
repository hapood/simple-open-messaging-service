import { requireEnv } from '../common/env.js';
import { isValidSocfpDomain } from '../common/account.js';

/**
 * Federation (S2S) configuration. Loaded from env at module-init time (fail-fast via requireEnv).
 */
export interface FederationConfig {
  /** This server's public domain — the domain in @user@domain handles and in .well-known/socfp. */
  domain: string;
  /** File path to the persisted Ed25519 S2S keypair (generated on first boot). */
  keyPath: string;
  /** TTL for cached peer signing keys fetched from .well-known (seconds). */
  keyCacheTtlSec: number;
  /** Per-attempt connect timeout for outbound S2S HTTP requests (seconds). §6.4 (v4/v6 racing backstop). */
  connectTimeoutSec: number;
  /** Overall timeout for an outbound S2S HTTP call — connect + transfer + response (seconds). Applies
   *  to control traffic (friend ops, /missed, /ping); NOT to the media fetch, which
   *  uses mediaChunkTimeoutSec per chunk (a large file can't cross in callTimeoutSec). */
  callTimeoutSec: number;
  /** Federation media fetch (GET /media/:digest): byte size of one Range request — the bounded per-request
   *  memory AND the resume granularity. A chunk that drops/stalls is re-issued from its own offset,
   *  never from zero, so this is the worst-case wasted work on a flaky link. No whole-file buffer. */
  mediaChunkBytes: number;
  /** Step 2 media fetch: per-chunk timeout (seconds) — covers connect + headers + that one chunk's
   *  body. Deliberately generous vs callTimeoutSec: a chunk is bounded but may cross a slow WAN, and a
   *  wall-clock timeout here is inactivity-bounded in practice (each chunk that arrives resets progress). */
  mediaChunkTimeoutSec: number;
  /** Step 2 media fetch: consecutive chunk failures (network stall, body abort) before giving up
   *  best-effort on a digest — the message stays inert (no MediaAsset, no render) for a later retry,
   *  and the peer is NOT degraded (a transfer stall is not a trust failure). */
  mediaMaxChunkRetries: number;
  /** dev-only: allow plain http:// for localhost federation testing (never in production). */
  allowInsecureHttp: boolean;
  /** Dev-only static peer routes. This deliberately bypasses DNS/SRV so two local nodes can federate
   *  over a Docker network while keeping their logical SOMS domains. Forbidden in production. */
  devRoutes: Readonly<Record<string, string>>;
}

function loadDevRoutes(allowInsecureHttp: boolean): Record<string, string> {
  const raw = process.env.SOMS_DEV_FEDERATION_ROUTES;
  const production = process.env.NODE_ENV === 'production';
  if (production && (raw !== undefined || allowInsecureHttp)) {
    throw new Error(
      'SOMS_ALLOW_INSECURE_HTTP and SOMS_DEV_FEDERATION_ROUTES are forbidden when NODE_ENV=production',
    );
  }
  if (raw === undefined) return {};
  if (!allowInsecureHttp) {
    throw new Error(
      'SOMS_DEV_FEDERATION_ROUTES requires SOMS_ALLOW_INSECURE_HTTP=1',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('SOMS_DEV_FEDERATION_ROUTES must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SOMS_DEV_FEDERATION_ROUTES must be a JSON object');
  }

  const routes: Record<string, string> = {};
  for (const [domain, value] of Object.entries(parsed)) {
    const normalized = domain.toLowerCase();
    if (domain !== normalized || !isValidSocfpDomain(normalized)) {
      throw new Error(
        `SOMS_DEV_FEDERATION_ROUTES contains invalid canonical domain: ${domain}`,
      );
    }
    if (typeof value !== 'string') {
      throw new Error(
        `development federation route for ${domain} must be a URL`,
      );
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(
        `development federation route for ${domain} must be a URL`,
      );
    }
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        `development federation route for ${domain} must be an http:// origin without credentials, path, query, or fragment`,
      );
    }
    routes[normalized] = url.origin;
  }
  return routes;
}

export function loadFederationConfig(): FederationConfig {
  const allowInsecureHttp = process.env.SOMS_ALLOW_INSECURE_HTTP === '1';
  const domain = requireEnv('SOMS_DOMAIN');
  if (!isValidSocfpDomain(domain)) {
    throw new Error(
      'SOMS_DOMAIN must be a canonical SOCFP Domain and must not use the RFC 6762 .local namespace',
    );
  }
  return {
    domain,
    keyPath: './data/soms-s2s-key.json',
    keyCacheTtlSec: Number(process.env.SOMS_KEY_CACHE_TTL_SEC ?? 6 * 60 * 60), // 6h
    connectTimeoutSec: Number(process.env.SOMS_CONNECT_TIMEOUT_SEC ?? 12),
    callTimeoutSec: Number(process.env.SOMS_CALL_TIMEOUT_SEC ?? 12),
    mediaChunkBytes: Number(
      process.env.SOMS_MEDIA_CHUNK_BYTES ?? 8 * 1024 * 1024,
    ),
    mediaChunkTimeoutSec: Number(
      process.env.SOMS_MEDIA_CHUNK_TIMEOUT_SEC ?? 120,
    ),
    mediaMaxChunkRetries: Number(process.env.SOMS_MEDIA_MAX_CHUNK_RETRIES ?? 5),
    allowInsecureHttp,
    devRoutes: loadDevRoutes(allowInsecureHttp),
  };
}

/**
 * Federated-peer daily-quota configuration. These are the global defaults; a per-peer override on
 * FederatedPeer takes precedence when set (null override → use the default here). Thresholds
 * Loaded separately from FederationConfig to keep the
 * transport config focused. See src/quota/quota.service.ts.
 */
export interface QuotaConfig {
  /** Inbound friend ops/day per node (anti-spam). */
  dailyRequestLimit: number;
  /** Messages/day per node. */
  dailyMsgLimit: number;
  /** Federated WebRTC signal frames/day per node (offer/answer/ICE relay). A dedicated budget so an ICE
   *  burst can't starve, or be starved by, the friend-op `requests` bucket. No per-node override (global). */
  dailySignalLimit: number;
  /** File items/day per node for the file-cnt breaker dimension. All file types (image/video/audio/file) count
   *  +1; a forward bundle counts +1 regardless of inner asset count. */
  dailyFileLimit: number;
  /** Total file bytes/day per node for the file-total-size breaker dimension (uploads + downloads, actual
   *  bytes). Bundles contribute 0 bytes. */
  dailyFileBytesLimit: number;
}
