import {
  Controller,
  Post,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { S2sVerifyService } from './s2s-verify.service.js';
import { FederationService } from './federation.service.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * S2S trust-establishment endpoint — `POST /api/v1/s2s/init`. This is the bootstrap by which two SOMS
 * servers establish mutual trust BEFORE any inbox traffic (Gate 1 allow-list must pass before a
 * friend.request can be sent). It is NOT guarded by S2sSignatureGuard — it IS the trust step, so the
 * allow-list gate would be circular. Instead it verifies the requester's RFC 9421 signature directly via
 * S2sVerifyService (parse keyId → fetch the requester's public key from their .well-known, authoritative
 * over HTTPS → verify), then AUTO-ACCEPTS the requester into FederatedPeer trusted.
 *
 * v0.1 = AUTO-ACCEPT: any SOMS peer whose init signature verifies is trusted. The real abuse barrier is
 * the friend gate (Gate 2) — a connected peer can only send friend REQUESTS the local user must approve;
 * there is no message read access without an approved friend edge, so server-level auto-accept is
 * contained. The "accept" step below is a single swappable site for future admin-approval / deny-list /
 * reputation gating (reserved hook, not built in v0.1).
 *
 * Raw-body capture (bootstrap.ts preParsing, scoped to /api/v1/s2s/*) feeds req.rawBody to the verifier
 * so the content-digest matches what the sender signed.
 */
@Controller('s2s')
export class S2sInitController {
  constructor(
    private readonly verify: S2sVerifyService,
    private readonly federationService: FederationService,
  ) {}

  @Post('init')
  @HttpCode(HttpStatus.OK)
  async postInit(
    @Req() req: FastifyRequest,
  ): Promise<{ code: number; message: string; data: null }> {
    // Verify the requester's signature via their own .well-known (no inline key — the requester can't
    // lie; .well-known is CA-validated HTTPS). Throws FEDERATION_MALFORMED / KEY_FETCH_FAILED /
    // BAD_SIGNATURE on failure (caller-appropriate status codes).
    const headers = this.verify.extractHeaders(req);
    const { keyId, domain } = this.verify.parseSigner(headers);
    await this.verify.fetchAndVerify(this.verify.signedRequest(req), headers, keyId, domain);

    // AUTO-ACCEPT (v0.1): trust established. markTrusted is idempotent + transition-aware — a first
    // contact logs discovered+trusted; a re-init from a demoted peer re-trusts and logs the transition;
    // a repeat init from an already-trusted peer just refreshes lastSuccessAt. addedBy is null
    // (auto-accepted, no admin).
    await this.federationService.markTrusted(domain);
    return { code: BusinessCode.OK, message: 'ok', data: null };
  }
}
