import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { identityNamespace } from '../database/schema.js';
import { S2sVerifyService } from './s2s-verify.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { KeypairService } from './keypair.service.js';
import { FederationRecognitionService } from './federation-recognition.service.js';
import { parseRootKeyHeader } from './signature.service.js';

/**
 * Inbound S2S signature guard for the signed data-plane endpoints — Gate 1 (server allow-list +
 * valid signature). Identity is resolved by root: the request's S2S-Root-Key must name the root
 * pinned by exactly one unretired identity epoch, and the request must authenticate under a
 * certificate that epoch's pin authorizes. Traffic claiming a different root — including a
 * successor root of a rotation still awaiting local review — fails authentication here.
 * Recognize and Health have distinct bootstrap/status verification in
 * S2sRecognitionController and do not use this ordinary data-plane guard.
 *
 * Verification (keyId parse + .well-known key fetch + sig verify) is delegated to S2sVerifyService,
 * shared with the recognition bootstrap. This guard adds the local-facts gate and
 * the from.domain==signer.binding on top.
 *
 * Order is cheap → expensive AND permanent → transient, so untrusted/malformed senders are rejected
 * before any network key fetch, and a transient key-fetch failure never becomes a permanent 401:
 *
 *   1. missing/malformed Signature-Input / keyId / S2S-Root-Key → 400 FEDERATION_MALFORMED (no retry)
 *   2. claimed root not pinned / signer not recognized          → 401 (no retry)
 *   3. local recognition or receive readiness incomplete        → 401 FEDERATION_RECOGNITION_REQUIRED
 *   4. key fetch transient failure (.well-known unreachable)    → 500 INTERNAL (RETRY)
 *   5. keyId not in the peer's published key set                → 401 FEDERATION_BAD_SIGNATURE  (no retry)
 *   6. signature invalid / body tampered                        → 401 FEDERATION_BAD_SIGNATURE  (no retry)
 *   7. from.domain != signer.domain (bodies with `from`)        → 401 FEDERATION_BINDING_VIOLATION(no retry)
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
    const claimedRoot = parseRootKeyHeader(headers['s2s-root-key']);
    if (!claimedRoot) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing or malformed S2S-Root-Key header',
        HttpStatus.BAD_REQUEST,
      );
    }

    // 2. Resolve the identity epoch by the claimed root (unique among unretired pins).
    const peer = await this.database.db.query.identityNamespace.findFirst({
      columns: {
        id: true,
        domain: true,
        trustLevel: true,
        recognizesPeer: true,
        localServiceAvailable: true,
        haltCode: true,
      },
      where: and(
        eq(identityNamespace.rootPublicKey, claimedRoot),
        isNull(identityNamespace.retiredAt),
        sql`${identityNamespace.id} > 0`,
      ),
    });
    if (!peer) {
      // A known signer claiming a different root is a rotation (or forgery)
      // that stays unauthenticated until its review is approved.
      const byDomain = await this.database.db.query.identityNamespace.findFirst(
        {
          columns: { id: true },
          where: and(
            eq(identityNamespace.domain, signerDomain),
            eq(identityNamespace.active, true),
            isNull(identityNamespace.retiredAt),
          ),
        },
      );
      if (byDomain) {
        throw new BusinessException(
          BusinessCode.FEDERATION_BAD_SIGNATURE,
          `${signerDomain} claims a root that is not the pinned identity; a rotation awaiting review stays unauthenticated`,
          HttpStatus.UNAUTHORIZED,
        );
      }
      throw new BusinessException(
        BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
        `${signerDomain} is not recognized`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (peer.domain !== signerDomain) {
      // The pinned identity of this root is bound to another domain; a
      // re-binding stays pending until its review is approved.
      throw new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        `claimed root is pinned to ${peer.domain}, not ${signerDomain}`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (peer.trustLevel === 'halted') {
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
    if (!peer.recognizesPeer || !peer.localServiceAvailable) {
      throw new BusinessException(
        BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
        `${signerDomain} is not recognized`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    // 3-5. Fetch the signer's key (.well-known, fetch-on-miss) + verify the signature over the raw body.
    await this.verify.fetchAndVerify(
      this.verify.signedRequest(req),
      headers,
      keyId,
      signerDomain,
      peer.id,
    );

    // Authentication proves current reachability. Later binding, shape, or business rejection
    // must not erase that observation or manufacture peer-acceptance evidence.
    await this.recognition.markReachable(signerDomain);

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
      namespaceId: peer.id,
      keyId,
      signatureExpiresAtSec: expires,
    };
    return true;
  }
}
