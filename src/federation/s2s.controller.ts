import {
  Controller,
  Get,
  Post,
  HttpCode,
  HttpStatus,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { S2sSignatureGuard } from './s2s-signature.guard.js';
import { InboxHandler } from './inbox.handler.js';
import { FederationService, type S2SEnvelope, type S2SActor } from './federation.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * S2S endpoints (signature-guarded, allow-list gated). The guard verifies the RFC 9421 signature +
 * FederatedPeer trust + from.domain==signer binding + captures req.rawBody, then sets req.peer.
 *
 * - POST /api/v1/s2s/inbox — receive a friend.* envelope (InboxHandler dedupes + routes).
 * - GET  /api/v1/s2s/users/:username — return a local user's public profile (avatar inline as base64).
 * - GET  /api/v1/s2s/users/:username/revision — lightweight profile-revision probe (no avatar transfer)
 *   so a peer can detect a stale stub before paying for the full profile re-pull.
 *
 * NOTE: there is no friend.delete endpoint/envelope — unfriending is LOCAL-ONLY. The severed edge is
 * discovered lazily via rejection-on-send in Step 2 (see docs/federation-protocol.md).
 */
@Controller('s2s')
@UseGuards(S2sSignatureGuard)
export class S2sController {
  constructor(
    private readonly inbox: InboxHandler,
    private readonly federation: FederationService,
  ) {}

  @Post('inbox')
  @HttpCode(HttpStatus.OK)
  async postInbox(
    @Req() req: FastifyRequest,
  ): Promise<{ code: number; message: string; data: null }> {
    await this.inbox.handle(req.body as S2SEnvelope);
    return { code: BusinessCode.OK, message: 'ok', data: null };
  }

  @Get('users/:username')
  async getUserProfile(@Param('username') username: string) {
    // The endpoint serves OUR users only, so the domain is implicitly ours. The username is the sole
    // path segment — no `@`-joined address on the wire (the `@` is a UI input aid, split client-side).
    const actor: S2SActor = { username, domain: this.federation.ourDomain };
    const profile = await this.federation.getLocalUserProfile(actor);
    if (!profile) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `user ${username} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    return profile;
  }

  @Get('users/:username/revision')
  async getUserRevision(@Param('username') username: string) {
    const actor: S2SActor = { username, domain: this.federation.ourDomain };
    const rev = await this.federation.getLocalUserRevision(actor);
    if (!rev) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `user ${username} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    return rev;
  }
}
