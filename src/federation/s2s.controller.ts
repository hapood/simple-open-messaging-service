import {
  Controller,
  Get,
  Post,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createReadStream } from 'node:fs';
import { S2sSignatureGuard } from './s2s-signature.guard.js';
import { FriendOpHandler } from './friend-op.handler.js';
import { FederationService, type S2SPayload, type S2SFriendRequest, type S2SAddress } from './federation.service.js';
import { FederationBufferService } from './federation-buffer.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * S2S endpoints (signature-guarded, allow-list gated). The guard verifies the RFC 9421 signature +
 * FederatedPeer trust + from.domain==signer binding + captures req.rawBody, then sets req.peer.
 *
 * - POST /api/v1/s2s/friend-request — receive a friend-request payload (FriendOpHandler dedupes + applies).
 * - POST /api/v1/s2s/friend-approve — receive a friend-approve payload.
 * - GET  /api/v1/s2s/users/:username — return a local user's public profile (avatar inline as base64).
 * - GET  /api/v1/s2s/users/:username/revision — lightweight profile-revision probe (no avatar transfer)
 *   so a peer can detect a stale stub before paying for the full profile re-pull.
 *
 * NOTE: there is no friend.delete endpoint — unfriending is LOCAL-ONLY. The severed edge is discovered
 * lazily via rejection-on-send in Step 2 (see docs/federation-protocol.md).
 */
@Controller('s2s')
@UseGuards(S2sSignatureGuard)
export class S2sController {
  constructor(
    private readonly friendOp: FriendOpHandler,
    private readonly federation: FederationService,
    private readonly federationBuffer: FederationBufferService,
  ) {}

  @Post('friend-request')
  @HttpCode(HttpStatus.OK)
  async postFriendRequest(
    @Req() req: FastifyRequest,
  ): Promise<{ code: number; message: string; data: null }> {
    await this.friendOp.handleRequest(req.body as S2SFriendRequest);
    return { code: BusinessCode.OK, message: 'ok', data: null };
  }

  @Post('friend-approve')
  @HttpCode(HttpStatus.OK)
  async postFriendApprove(
    @Req() req: FastifyRequest,
  ): Promise<{ code: number; message: string; data: null }> {
    await this.friendOp.handleApprove(req.body as S2SPayload);
    return { code: BusinessCode.OK, message: 'ok', data: null };
  }

  @Get('users/:username')
  async getUserProfile(@Param('username') username: string) {
    // The endpoint serves OUR users only, so the domain is implicitly ours. The username is the sole
    // path segment — no `@`-joined address on the wire (the `@` is a UI input aid, split client-side).
    const address: S2SAddress = { username, domain: this.federation.ourDomain };
    const profile = await this.federation.getLocalUserProfile(address);
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
    const address: S2SAddress = { username, domain: this.federation.ourDomain };
    const rev = await this.federation.getLocalUserRevision(address);
    if (!rev) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `user ${username} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    return rev;
  }

  // ─── Step 2: coalesced hint map + message pull (serving side) ────────────────

  /** GET /api/v1/s2s/new-msg-map — the peer pulls OUR outbound hint entries (the one-directional
   *  fallback, §4.3). Non-destructive: we serve a snapshot; entries leave only on a successful PUSH ack.
   *  The requester is the signing server (req.peer.domain). See docs/federation-step2-design.md §3.1. */
  @Get('new-msg-map')
  async getNewMsgMap(
    @Req() req: FastifyRequest,
    @Query('cursor') cursorParam?: string,
    @Query('take') takeParam?: string,
  ) {
    const cursor = Number(cursorParam ?? '0') || 0;
    // Cap matches FederationBufferService.BATCH (1000); keeps one batch ≈ 80 KB.
    const take = Math.min(Number(takeParam ?? '1000') || 1000, 1000);
    return this.federationBuffer.snapshotOutboundFor(this.signerDomain(req), cursor, take);
  }

  /** GET /api/v1/s2s/messages — the peer pulls the SENDER's side of a 1:1 thread (authoritative,
   *  §3.2). `from` is OUR local user; `to` is the requester's user (the signer). Gate 2 (APPROVED
   *  friendship) is enforced inside serveOutboundMessages. */
  @Get('messages')
  async getMessages(
    @Req() req: FastifyRequest,
    @Query('from') fromUsername?: string,
    @Query('to') toUsername?: string,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
  ) {
    if (!fromUsername || !toUsername) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing from/to query param',
        HttpStatus.BAD_REQUEST,
      );
    }
    const after = Number(afterParam ?? '0') || 0;
    const take = Math.min(Number(takeParam ?? '50') || 50, 50);
    return this.federation.serveOutboundMessages(
      fromUsername,
      toUsername,
      this.signerDomain(req),
      after,
      take,
    );
  }

  /** POST /api/v1/s2s/new-msg-map — a peer pushes ITS outbound hint entries (dirty conversations) to us.
   *  Validate `origin === signer` (belt-and-suspenders over the signature), then enqueue + drain. ACKs
   *  fast — the actual message pull runs out of band. See docs/federation-step2-design.md §3.1 / §4.2. */
  @Post('new-msg-map')
  @HttpCode(HttpStatus.OK)
  async postNewMsgMap(
    @Req() req: FastifyRequest,
  ): Promise<{ code: number; message: string; data: null }> {
    const body = req.body as { origin?: unknown; entries?: unknown } | undefined;
    const signer = this.signerDomain(req);
    if (typeof body?.origin !== 'string' || body.origin !== signer) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BINDING_VIOLATION,
        `origin (${String(body?.origin)}) != signer (${signer})`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const entries = Array.isArray(body?.entries) ? body.entries : [];
    this.federation.receiveNewMsgMapPush(
      signer,
      entries as ReadonlyArray<{ from?: unknown; to?: unknown; latestSeq?: unknown }>,
    );
    return { code: BusinessCode.OK, message: 'ok', data: null };
  }

  /** The verified signer domain (set by S2sSignatureGuard as req.peer.domain). */
  private signerDomain(req: FastifyRequest): string {
    return (req as FastifyRequest & { peer: { domain: string } }).peer.domain;
  }

  /** GET /api/v1/s2s/ping — signed liveness probe (reconnect sweep + quiet-peer lastSuccessAt, §3.4).
   *  Distinct from the init handshake (which establishes trust); a successful signed ping proves the
   *  peer is reachable + the mutual keys still verify. Advances the requester's liveness watermark. */
  @Get('ping')
  async ping(@Req() req: FastifyRequest) {
    await this.federation.markContactSuccess(this.signerDomain(req));
    return { domain: this.federation.ourDomain, ts: Date.now() };
  }

  /** GET /api/v1/s2s/get_file — stream a chat-media asset by sha256 digest (3-check authz, §3.3). The
   *  receiver already knows the extension from the message content URL and re-serves same-origin via
   *  @fastify/static (which maps ext→mime), so the S2S Content-Type is octet-stream (incidental). */
  @Get('get_file')
  async getFile(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('digest') digest?: string,
    @Query('from') fromUsername?: string,
    @Query('to') toUsername?: string,
  ) {
    if (!digest || !fromUsername || !toUsername) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing digest/from/to query param',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { absPath, bytes } = await this.federation.resolveMediaFile(
      fromUsername,
      toUsername,
      this.signerDomain(req),
      digest,
    );
    reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(bytes))
      .header('cache-control', 'no-store');
    return reply.send(createReadStream(absPath));
  }
}
