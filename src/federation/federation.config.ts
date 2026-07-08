import { requireEnv } from '../common/env.js';

/**
 * Federation (S2S) configuration. Loaded from env at module-init time (fail-fast via requireEnv).
 * See docs/federation-protocol.md Part II.
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
  /** Overall timeout for an outbound S2S HTTP call — connect + transfer + response (seconds). */
  callTimeoutSec: number;
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
    allowInsecureHttp: process.env.SOMS_ALLOW_INSECURE_HTTP === '1',
  };
}
