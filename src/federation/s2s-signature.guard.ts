import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../prisma.service.js';
import { SignatureService } from './signature.service.js';
import { DiscoveryService } from './discovery.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

/** Extract the signer domain from a keyId like "aaa.com/key-1" → "aaa.com" (the part before the first '/'). */
function domainFromKeyId(keyId: string): string {
  return keyId.split('/')[0];
}

/** Parse an actor handle "@alice@aaa.com" → { localpart, domain }. Returns null if not handle-shaped. */
function parseHandle(h: string): { localpart: string; domain: string } | null {
  const m = /^@([^@]+)@(.+)$/.exec(h);
  return m ? { localpart: m[1], domain: m[2] } : null;
}

/**
 * Inbound S2S signature guard — Gate 1 (server allow-list + valid signature). Verifies the request
 * was signed by a TRUSTED peer's CURRENT key and that the asserted sender's domain matches the
 * signer's domain (binding rule — each server vouches only for its own users).
 *
 * Order is cheap → expensive AND permanent → transient, so untrusted/malformed senders are rejected
 * before any network key fetch, and a transient key-fetch failure never becomes a permanent 401:
 *
 *   1. missing/malformed Signature-Input / keyId            → 401 FEDERATION_MALFORMED       (no retry)
 *   2. signer domain not in FederatedPeer trusted           → 401 FEDERATION_PEER_NOT_TRUSTED (no retry)
 *   3. key fetch transient failure (.well-known unreachable)→ 503 FEDERATION_KEY_FETCH_FAILED (RETRY)
 *   4. keyId not in the peer's published key set            → 401 FEDERATION_BAD_SIGNATURE    (no retry)
 *   5. signature invalid / body tampered                    → 401 FEDERATION_BAD_SIGNATURE    (no retry)
 *   6. from.domain != signer.domain (envelopes only)        → 401 FEDERATION_BINDING_VIOLATION(no retry)
 *
 * On success, attaches `req.peer = { domain, keyId }` for the handler. Mirrors NotificationTokenGuard
 * (a plain CanActivate, not Passport-based).
 */
@Injectable()
export class S2sSignatureGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signature: SignatureService,
    private readonly discovery: DiscoveryService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const headers = {
      date: req.headers.date as string,
      'content-digest': req.headers['content-digest'] as string,
      'signature-input': req.headers['signature-input'] as string,
      signature: req.headers.signature as string,
    };

    // 1. Parse keyId from Signature-Input (the keyid="..." param, anywhere in the string).
    const keyIdMatch = (headers['signature-input'] ?? '').match(/keyid="([^"]+)"/);
    if (!keyIdMatch) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing keyid in Signature-Input',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const keyId = keyIdMatch[1];
    const signerDomain = domainFromKeyId(keyId);
    if (!signerDomain) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `malformed keyId "${keyId}"`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    // 2. Gate 1 allow-list: is this domain a trusted peer? (Cheap indexed lookup BEFORE any fetch.)
    const peer = await this.prisma.federatedPeer.findUnique({
      where: { domain: signerDomain },
    });
    if (!peer || peer.trustLevel !== 'trusted') {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_NOT_TRUSTED,
        `${signerDomain} is not a trusted peer`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    // 3. Fetch the signer's public key (fetch-on-miss + TTL cache). Transient fetch failure → 503.
    let publicKey: Uint8Array | null;
    try {
      publicKey = await this.discovery.getPublicKey(signerDomain, keyId);
    } catch (e) {
      throw new BusinessException(
        BusinessCode.FEDERATION_KEY_FETCH_FAILED,
        `key fetch failed for ${signerDomain}: ${(e as Error).message}`,
        HttpStatus.SERVICE_UNAVAILABLE, // → outbox retries
      );
    }
    if (!publicKey) {
      // Fetch succeeded but this keyId isn't published → signer using a retired/wrong key (permanent).
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        `keyId ${keyId} not published by ${signerDomain}`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    // 4. Verify the signature over the raw body + covered components.
    const ok = this.signature.verifyWithKey(
      {
        method: req.method.toUpperCase(),
        path: (req.url ?? '').split('?')[0],
        authority: (req.headers.host as string) ?? '',
        body: req.rawBody?.toString('utf8') ?? '',
      },
      headers,
      publicKey,
    );
    if (!ok) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        'signature verification failed',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // 5. Binding rule (envelopes only — a `from` field implies an envelope; GET /actors has none):
    // the asserted sender must live on the signer's domain, so a trusted peer can't forge users of
    // another peer.
    const fromHandle = (req.body as { from?: string } | undefined)?.from;
    if (fromHandle) {
      const from = parseHandle(fromHandle);
      if (!from || from.domain !== signerDomain) {
        throw new BusinessException(
          BusinessCode.FEDERATION_BINDING_VIOLATION,
          `from.domain (${from?.domain ?? 'malformed'}) != signer (${signerDomain})`,
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    // 6. Stash the verified signer for the handler.
    req.peer = { domain: signerDomain, keyId };
    return true;
  }
}
