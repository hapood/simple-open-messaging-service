import { Injectable } from '@nestjs/common';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createHash } from 'node:crypto';
import { KeypairService } from './keypair.service.js';

/**
 * S2S request signing — DKIM-model on RFC 9421 (HTTP Message Signatures) wire format, Ed25519.
 * See docs/federation-protocol.md §5.1. The signer and verifier are both our code, so we fix one
 * canonical covered-component set for v0.1; both sides use it.
 *
 * Covered components: @method @path @authority date content-digest
 *   - @method / @path / @authority bind the request target (signature can't be replayed onto a
 *     different endpoint or host).
 *   - date is the RFC 7231 Date header (freshness signal; replay itself is handled by (origin,id) dedup).
 *   - content-digest binds the body (RFC 9530) — body tamper breaks the digest check.
 *
 * Key distribution is DECOUPLED from this service: verifyWithKey takes the public key as a param.
 * The caller (FriendOpHandler) resolves the key via DiscoveryService.getPublicKey(domain, keyId)
 * (fetch-on-miss + TTL cache, §5.1). This keeps SignatureService free of DiscoveryService and
 * unit-testable in isolation.
 *
 * Error contract: verifyWithKey NEVER throws — any malformed header, digest mismatch, or failed
 * signature returns `false`. Callers treat `false` as a permanent signature failure (401, no retry).
 */

const SIG_LABEL = 'sig1';

export interface SignedRequest {
  method: string; // uppercase, e.g. POST
  path: string; // absolute path WITHOUT query, e.g. /api/v1/s2s/friend-request
  authority: string; // host[:port] — the Host/authority value
  body: string;
}

export interface OutboundSignatureHeaders {
  date: string;
  'content-digest': string;
  'signature-input': string;
  signature: string;
}

/** Content-Digest value: sha-256=<base64(sha256(body))> (RFC 9530). */
export function contentDigest(body: string | Uint8Array): string {
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  return 'sha-256=' + createHash('sha256').update(bytes).digest('base64');
}

/** Serialize the signature-params field (the value after `sig1=` in Signature-Input). */
export function buildSignatureParams(keyId: string, created: number): string {
  const components = '("@method" "@path" "@authority" "date" "content-digest")';
  // Parameter order is fixed within our protocol; the verifier reads it back verbatim from the header.
  return `${components};created=${created};keyid="${keyId}";alg="ed25519"`;
}

/**
 * Build the RFC 9421 §2.3 signature base. Each covered component is one
 * `<component-id> SP <value> LF` line; the final line is always "@signature-params" carrying the
 * signature-params value (which MUST byte-match the Signature-Input header's payload).
 */
export function buildSignatureBase(
  v: { method: string; path: string; authority: string; date: string; contentDigest: string },
  signatureParams: string,
): string {
  return (
    [
      `"@method" ${v.method}`,
      `"@path" ${v.path}`,
      `"@authority" ${v.authority}`,
      `"date" ${v.date}`,
      `"content-digest" ${v.contentDigest}`,
      `"@signature-params" ${signatureParams}`,
    ].join('\n') + '\n'
  );
}

@Injectable()
export class SignatureService {
  constructor(private readonly keypair: KeypairService) {}

  /** Sign an outbound S2S request; returns the four headers to attach (Date, Content-Digest, Signature-Input, Signature). */
  signOutbound(req: SignedRequest): OutboundSignatureHeaders {
    const created = Math.floor(Date.now() / 1000);
    const date = new Date().toUTCString();
    const digest = contentDigest(req.body);
    const keyId = this.keypair.getKeyId();
    const sigParams = buildSignatureParams(keyId, created);
    const base = buildSignatureBase(
      { method: req.method, path: req.path, authority: req.authority, date, contentDigest: digest },
      sigParams,
    );
    const sig = ed25519.sign(new TextEncoder().encode(base), this.keypair.getPrivateKey());
    return {
      date,
      'content-digest': digest,
      'signature-input': `${SIG_LABEL}=${sigParams}`,
      signature: `${SIG_LABEL}=:${Buffer.from(sig).toString('base64')}:`,
    };
  }

  /**
   * Verify an inbound S2S request against a known peer public key. The caller resolves the key
   * (DiscoveryService, by keyId) and enforces allow-list + domain binding. Returns true ONLY if
   * the Content-Digest matches the body AND the signature verifies. Never throws.
   */
  verifyWithKey(
    req: SignedRequest,
    headers: OutboundSignatureHeaders,
    publicKey: Uint8Array,
  ): boolean {
    // Signature-Input must be "sig1=<params>" (our single-label scheme).
    const siMatch = headers['signature-input'].match(/^sig1=(.+)$/);
    if (!siMatch) return false;
    const sigParams = siMatch[1];

    // Body integrity: the Content-Digest header must match the actual body (independently of the signature).
    if (headers['content-digest'] !== contentDigest(req.body)) return false;

    // Signature must be "sig1=:<base64>:".
    const sigMatch = headers.signature.match(/^sig1=:([^:]+):$/);
    if (!sigMatch) return false;
    const sigBytes = Uint8Array.from(Buffer.from(sigMatch[1], 'base64'));

    const base = buildSignatureBase(
      {
        method: req.method,
        path: req.path,
        authority: req.authority,
        date: headers.date,
        contentDigest: headers['content-digest'],
      },
      sigParams,
    );
    return ed25519.verify(sigBytes, new TextEncoder().encode(base), publicKey);
  }
}
