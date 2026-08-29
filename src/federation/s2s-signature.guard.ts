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
import { FederationRecognitionService } from './federation-recognition.service.js';

/**
 * Inbound S2S signature guard for the friend-op + signed GET endpoints — Gate 1 (server allow-list +
 * valid signature). Verifies the request was signed by a recognized peer's authorized key and that the
 * asserted sender's domain matches the signer's domain (binding rule — each server vouches only for
 * its own users). Recognize and Health have distinct bootstrap/status verification in
 * S2sRecognitionController and do not use this ordinary data-plane guard.
 *
 * Verification (keyId parse + .well-known key fetch + sig verify) is delegated to S2sVerifyService,
 * shared with the recognition bootstrap. This guard adds the local-facts gate and
 * the from.domain==signer.binding on top.
 *
 * Order is cheap → expensive AND permanent → transient, so untrusted/malformed senders are rejected
 * before any network key fetch, and a transient key-fetch failure never becomes a permanent 401:
 *
 *   1. missing/malformed Signature-Input / keyId            → 401 FEDERATION_MALFORMED       (no retry)
 *   2. bilateral recognition facts incomplete              → 401 FEDERATION_RECOGNITION_REQUIRED
 *   3. key fetch transient failure (.well-known unreachable)→ 500 INTERNAL (RETRY)
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
    private readonly recognition: FederationRecognitionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    this.keypair.assertAvailable();
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const headers = this.verify.extractHeaders(req);

    // 1. Parse keyId from Signature-Input → signer domain (cheap, no network).
    const {
      keyId,
      domain: signerDomain,
      expires,
    } = this.verify.parseSigner(headers);

    // 2. Gate recognition using local facts before any network fetch.
    const peer = await this.database.db.query.federatedPeer.findFirst({
      columns: {
        trustLevel: true,
        activeNamespaceId: true,
        recognizesPeer: true,
        outboundRecognitionConfirmed: true,
        inboundRecognitionConfirmed: true,
        lightweightInboundReady: true,
        localServiceAvailable: true,
        haltCode: true,
        haltReason: true,
      },
      where: eq(federatedPeer.domain, signerDomain),
    });
    if (peer?.trustLevel === 'halted') {
      const code = [
        BusinessCode.FEDERATION_PEER_BLOCKED,
        BusinessCode.FEDERATION_IDENTITY_MISMATCH,
        BusinessCode.FEDERATION_PROTOCOL_VERSION_UNSUPPORTED,
      ].includes(peer.haltCode as BusinessCode)
        ? peer.haltCode!
        : BusinessCode.FEDERATION_IDENTITY_MISMATCH;
      throw new BusinessException(
        code,
        `${signerDomain} federation relationship is halted`,
        HttpStatus.CONFLICT,
      );
    }
    if (!peer || peer.activeNamespaceId === null) {
      throw new BusinessException(
        BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
        `${signerDomain} is not recognized`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const lightweight = req.url?.startsWith('/s2s/v1/feed-heads');
    const admitted = lightweight
      ? peer.inboundRecognitionConfirmed && peer.lightweightInboundReady
      : peer.recognizesPeer &&
        peer.outboundRecognitionConfirmed &&
        peer.inboundRecognitionConfirmed &&
        peer.localServiceAvailable;
    if (!admitted) {
      throw new BusinessException(
        BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
        `${signerDomain} recognition is incomplete`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    // 3-5. Fetch the signer's key (.well-known, fetch-on-miss) + verify the signature over the raw body.
    await this.verify.fetchAndVerify(
      this.verify.signedRequest(req),
      headers,
      keyId,
      signerDomain,
      peer.activeNamespaceId,
    );

    // 6. Binding rule (bodies carrying a `from` field; GETs have none): the asserted sender must live
    // on the signer's domain, so a recognized peer can't forge users of another peer. `from` is a
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
    req.peer = {
      domain: signerDomain,
      namespaceId: peer.activeNamespaceId,
      keyId,
      signatureExpiresAtSec: expires,
    };
    await this.recognition.markReachable(signerDomain);
    return true;
  }
}
