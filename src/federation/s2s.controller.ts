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
import { FederationService, parseHandle, type S2SEnvelope } from './federation.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * S2S endpoints (signature-guarded, allow-list gated). The guard verifies the RFC 9421 signature +
 * FederatedPeer trust + from.domain==signer binding + captures req.rawBody, then sets req.peer.
 *
 * - POST /api/v1/s2s/inbox — receive a friend.* envelope (InboxHandler dedupes + routes).
 * - GET  /api/v1/s2s/users/:handle — return a local user's public profile (avatar inline as base64).
 * - GET  /api/v1/s2s/users/:handle/revision — lightweight profile-revision probe (no avatar transfer)
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

  @Get('users/:handle')
  async getUserProfile(@Param('handle') handleRaw: string) {
    const h = parseHandle(decodeURIComponent(handleRaw));
    if (!h) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `malformed user handle "${handleRaw}"`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const profile = await this.federation.getLocalUserProfile(h);
    if (!profile) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `user ${handleRaw} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    return profile;
  }

  @Get('users/:handle/revision')
  async getUserRevision(@Param('handle') handleRaw: string) {
    const h = parseHandle(decodeURIComponent(handleRaw));
    if (!h) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `malformed user handle "${handleRaw}"`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const rev = await this.federation.getLocalUserRevision(h);
    if (!rev) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `user ${handleRaw} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    return rev;
  }
}
