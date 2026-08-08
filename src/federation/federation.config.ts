import { requireEnv } from '../common/env.js';

/**
 * Federation (S2S) configuration. Loaded from env at module-init time (fail-fast via requireEnv).
 */
export interface FederationConfig {
  /** This server's public domain — the domain in @user@domain handles and in .well-known/soms. */
  domain: string;
  /** File path to the persisted Ed25519 S2S keypair (generated on first boot). */
  keyPath: string;
  /** TTL for cached peer signing keys fetched from .well-known (seconds). */
  keyCacheTtlSec: number;
  /** Per-attempt connect timeout for outbound S2S HTTP requests (seconds). §6.4 (v4/v6 racing backstop). */
  connectTimeoutSec: number;
  /** Overall timeout for an outbound S2S HTTP call — connect + transfer + response (seconds). Applies
   *  to control traffic (friend ops, /messages, /new-msg-map, /ping); NOT to the media fetch, which
   *  uses mediaChunkTimeoutSec per chunk (a large file can't cross in callTimeoutSec). */
  callTimeoutSec: number;
  /** Step 2 media fetch (GET /get_file): byte size of one Range request — the bounded per-request
   *  memory AND the resume granularity. A chunk that drops/stalls is re-issued from its own offset,
   *  never from zero, so this is the worst-case wasted work on a flaky link. No whole-file buffer. */
  mediaChunkBytes: number;
  /** Step 2 media fetch: per-chunk timeout (seconds) — covers connect + headers + that one chunk's
   *  body. Deliberately generous vs callTimeoutSec: a chunk is bounded but may cross a slow WAN, and a
   *  wall-clock timeout here is inactivity-bounded in practice (each chunk that arrives resets progress). */
  mediaChunkTimeoutSec: number;
  /** Step 2 media fetch: consecutive chunk failures (network stall, body abort) before giving up
   *  best-effort on a digest — the message stays inert (no MediaAsset, no render) for a later retry,
   *  and the peer is NOT demoted (a transfer stall is not a trust failure). */
  mediaMaxChunkRetries: number;
  /** dev-only: allow plain http:// for localhost federation testing (never in production). */
  allowInsecureHttp: boolean;
}

export function loadFederationConfig(): FederationConfig {
  return {
    domain: requireEnv('SOMS_DOMAIN'),
    keyPath: process.env.SOMS_S2S_KEY_PATH ?? './data/soms-s2s-key.json',
    keyCacheTtlSec: Number(process.env.SOMS_KEY_CACHE_TTL_SEC ?? 6 * 60 * 60), // 6h
    connectTimeoutSec: Number(process.env.SOMS_CONNECT_TIMEOUT_SEC ?? 5),
    callTimeoutSec: Number(process.env.SOMS_CALL_TIMEOUT_SEC ?? 10),
    mediaChunkBytes: Number(
      process.env.SOMS_MEDIA_CHUNK_BYTES ?? 8 * 1024 * 1024,
    ),
    mediaChunkTimeoutSec: Number(
      process.env.SOMS_MEDIA_CHUNK_TIMEOUT_SEC ?? 120,
    ),
    mediaMaxChunkRetries: Number(process.env.SOMS_MEDIA_MAX_CHUNK_RETRIES ?? 5),
    allowInsecureHttp: process.env.SOMS_ALLOW_INSECURE_HTTP === '1',
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

export function loadQuotaConfig(): QuotaConfig {
  return {
    dailyRequestLimit: Number(
      process.env.SOMS_QUOTA_DAILY_REQUEST_LIMIT ?? 100,
    ),
    dailyMsgLimit: Number(process.env.SOMS_QUOTA_DAILY_MSG_LIMIT ?? 5000),
    dailySignalLimit: Number(
      process.env.SOMS_QUOTA_DAILY_SIGNAL_LIMIT ?? 50_000,
    ),
    dailyFileLimit: Number(
      process.env.SOMS_QUOTA_DAILY_FILE_LIMIT ?? 500,
    ),
    dailyFileBytesLimit: Number(
      process.env.SOMS_QUOTA_DAILY_FILE_BYTES_LIMIT ?? 5 * 1024 * 1024 * 1024,
    ),
  };
}
