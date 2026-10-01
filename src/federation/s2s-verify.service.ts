import { Injectable, HttpStatus } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  SignatureService,
  parseRootKeyHeader,
  type SignedRequest,
  type OutboundSignatureHeaders,
} from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { parseKeyId } from './key-id.js';

/**
 * Shared inbound RFC 9421 verification primitives — the keyId parse + .well-known key fetch + signature
 * verify used by BOTH the friend-op guard (allow-list-gated) and the init bootstrap (which IS the trust
 * establishment, so it skips the allow-list). Extracted so the two trust models share one verification
 * path instead of duplicating the signature/key-fetch logic.
 *
 * Error ordering is cheap → expensive AND permanent → transient (a transient key-fetch failure never
 * becomes a permanent 401):
 *   parseSigner        → 401 FEDERATION_MALFORMED       (no retry)
 *   fetchAndVerify     → 500 INTERNAL                    (RETRY) on transient fetch
 *                      → 401 FEDERATION_BAD_SIGNATURE    (no retry) if keyId unpublished / sig fails
 *
 * SignatureService is intentionally free of DiscoveryService (unit-testable); this service composes the
 * two (key resolution + crypto verify), keeping SignatureService pure.
 */
@Injectable()
export class S2sVerifyService {
  constructor(
    private readonly signature: SignatureService,
    private readonly discovery: DiscoveryService,
  ) {}

  /** Pull the four RFC 9421 headers plus S2S-Root-Key that Fastify
   *  normalized into req.headers. */
  extractHeaders(req: FastifyRequest): OutboundSignatureHeaders {
    return {
      date: req.headers.date as string,
      'content-digest': req.headers['content-digest'] as string,
      'signature-input': req.headers['signature-input'] as string,
      signature: req.headers.signature as string,
      's2s-root-key': req.headers['s2s-root-key'] as string,
    };
  }

  /** Build the SignedRequest (method/path/query/authority/body) the verifier expects. body comes from the
   *  /s2s/v1/* raw-body capture hook in bootstrap.ts — re-serialized JSON would not match the digest. */
  signedRequest(req: FastifyRequest): SignedRequest {
    const requestTarget = req.url ?? '';
    return {
      method: req.method.toUpperCase(),
      url: new URL(
        requestTarget,
        `${req.protocol}://${(req.headers.host as string) ?? ''}`,
      ),
      body: req.rawBody?.toString('utf8') ?? '',
    };
  }

  /** Parse the RFC 9421 keyId from Signature-Input → { keyId, signer domain }. Cheap, no network.
   *  The keyId must satisfy the full KeyId grammar; the domain before the first `/` is the signer
   *  domain. Throws FEDERATION_MALFORMED (400) on missing/malformed Signature-Input/keyId. */
  parseSigner(headers: OutboundSignatureHeaders): {
    keyId: string;
    domain: string;
    expires: number;
  } {
    if (
      !this.signature.hasValidMetadata(headers, Math.floor(Date.now() / 1000))
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'malformed or expired Signature-Input',
        HttpStatus.BAD_REQUEST,
      );
    }
    const metadata = this.signature.parseMetadata(headers);
    if (!metadata) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing required Signature-Input metadata',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { keyId, expires } = metadata;
    const parsed = parseKeyId(keyId);
    if (!parsed) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `malformed keyId "${keyId}"`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return { keyId, domain: parsed.domain, expires };
  }

  /**
   * Fetch the signer's public key from their .well-known (authoritative — fetch-on-miss + TTL cached,
   * so the requester can't lie with an inline key) and verify the signature over the raw body. Throws
   * INTERNAL (503 → sender retries) on a transient fetch failure; FEDERATION_BAD_SIGNATURE
   * (401, no retry) if the keyId isn't published or the signature/content-digest fails. Caches the key
   * on success (getPublicKey does the upsert).
   */
  async fetchAndVerify(
    req: SignedRequest,
    headers: OutboundSignatureHeaders,
    keyId: string,
    domain: string,
    namespaceId: number,
  ): Promise<void> {
    let publicKey: Uint8Array | null;
    try {
      publicKey = await this.discovery.getPublicKey(domain, namespaceId, keyId);
    } catch (e) {
      throw new BusinessException(
        BusinessCode.INTERNAL,
        `key fetch failed for ${domain}: ${(e as Error).message}`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!publicKey) {
      // Fetch succeeded but this keyId isn't published → signer using a retired/wrong key (permanent).
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        `keyId ${keyId} not published by ${domain}`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (!(await this.signature.verifyWithKey(req, headers, publicKey))) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        'signature verification failed',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  async verifyWithPublicKey(
    req: SignedRequest,
    headers: OutboundSignatureHeaders,
    publicKeyBase64: string,
  ): Promise<void> {
    if (
      !(await this.signature.verifyWithKey(
        req,
        headers,
        Uint8Array.from(Buffer.from(publicKeyBase64, 'base64')),
      ))
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        'signature verification failed',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
