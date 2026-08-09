import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { federatedPeer } from '../database/schema.js';
import { S2sVerifyService } from './s2s-verify.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { KeypairService } from './keypair.service.js';

/**
 * Inbound S2S signature guard for the friend-op + signed GET endpoints — Gate 1 (server allow-list +
 * valid signature). Verifies the request was signed by a TRUSTED peer's CURRENT key and that the
 * asserted sender's domain matches the signer's domain (binding rule — each server vouches only for
 * its own users). The trust-establishment endpoint POST /api/v1/s2s/ignite does NOT use this guard (it
 * IS the trust step) — see S2sIgniteController, which calls S2sVerifyService directly.
 *
 * Verification (keyId parse + .well-known key fetch + sig verify) is delegated to S2sVerifyService,
 * shared with the init bootstrap. This guard adds the allow-list gate (before any network fetch) and
 * the from.domain==signer.binding on top.
 *
 * Order is cheap → expensive AND permanent → transient, so untrusted/malformed senders are rejected
 * before any network key fetch, and a transient key-fetch failure never becomes a permanent 401:
 *
 *   1. missing/malformed Signature-Input / keyId            → 401 FEDERATION_MALFORMED       (no retry)
 *   2. signer domain not in FederatedPeer trusted           → 401 FEDERATION_PEER_NOT_TRUSTED (no retry)
 *   3. key fetch transient failure (.well-known unreachable)→ 503 FEDERATION_KEY_FETCH_FAILED (RETRY)
 *   4. keyId not in the peer's published key set            → 401 FEDERATION_BAD_SIGNATURE    (no retry)
 *   5. signature invalid / body tampered                    → 401 FEDERATION_BAD_SIGNATURE    (no retry)
 *   6. from.domain != signer.domain (bodies with `from`)     → 401 FEDERATION_BINDING_VIOLATION(no retry)
 *
 * On success, attaches `req.peer = { domain, keyId }` for the handler. A plain CanActivate, not
 * Passport-based.
 */
@Injectable()
export class S2sSignatureGuard implements CanActivate {
  constructor(
    private readonly database: DatabaseService,
    private readonly verify: S2sVerifyService,
    private readonly keypair: KeypairService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    this.keypair.assertAvailable();
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const headers = this.verify.extractHeaders(req);

    // 1. Parse keyId from Signature-Input → signer domain (cheap, no network).
    const { keyId, domain: signerDomain } = this.verify.parseSigner(headers);

    // 2. Gate 1 allow-list: is this domain a trusted peer? (Cheap indexed lookup BEFORE any fetch.)
    const peer = await this.database.db.query.federatedPeer.findFirst({
      columns: { trustLevel: true },
      where: eq(federatedPeer.domain, signerDomain),
    });
    if (
      peer?.trustLevel === 'identity_lost' ||
      peer?.trustLevel === 'reset_in_progress'
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
        `${signerDomain} identity is locked pending reset`,
        HttpStatus.LOCKED,
      );
    }
    // A signed ping is the only operation accepted from a demoted peer. This lets two peers that
    // demoted each other recover without weakening data endpoints or repeating /init. The pinned
    // current key is still verified below before the ping handler can promote the peer.
    const isPing = req.routeOptions.url?.endsWith('/s2s/ping') === true;
    if (
      !peer ||
      (peer.trustLevel !== 'trusted' &&
        !(peer.trustLevel === 'demoted' && isPing))
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PEER_NOT_TRUSTED,
        `${signerDomain} is not a trusted peer`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    // 3-5. Fetch the signer's key (.well-known, fetch-on-miss) + verify the signature over the raw body.
    await this.verify.fetchAndVerify(
      this.verify.signedRequest(req),
      headers,
      keyId,
      signerDomain,
    );

    // 6. Binding rule (bodies carrying a `from` field; GETs have none): the asserted sender must live
    // on the signer's domain, so a trusted peer can't forge users of another peer. `from` is a
    // {account, domain} object — no @-joined string on the wire.
    const fromAddress = (
      req.body as { from?: { account?: unknown; domain?: unknown } } | undefined
    )?.from;
    if (fromAddress) {
      const fromDomain =
        typeof fromAddress.domain === 'string' ? fromAddress.domain : undefined;
      if (!fromDomain || fromDomain !== signerDomain) {
        throw new BusinessException(
          BusinessCode.FEDERATION_BINDING_VIOLATION,
          `from.domain (${fromDomain ?? 'malformed'}) != signer (${signerDomain})`,
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    // Stash the verified signer for the handler.
    req.peer = { domain: signerDomain, keyId };
    return true;
  }
}
