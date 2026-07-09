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
import {
  FederationService,
  type S2SPayload,
  type S2SFriendRequest,
  type S2SThreadInvite,
  type S2SAddress,
} from './federation.service.js';
import { FederationBufferService } from './federation-buffer.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * S2S endpoints (signature-guarded, allow-list gated). The guard verifies the RFC 9421 signature +
 * FederatedPeer trust + from.domain==signer binding + captures req.rawBody, then sets req.peer.
 *
 * - POST /api/v1/s2s/friend-request — receive a friend-request payload (FriendOpHandler dedupes + applies).
 * - POST /api/v1/s2s/friend-approve — receive a friend-approve payload.
 * - GET  /api/v1/s2s/users/:account — return a local user's public profile (avatar inline as base64).
 * - GET  /api/v1/s2s/users/:account/revision — lightweight profile-revision probe (no avatar transfer)
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

  /** POST /api/v1/s2s/thread/invite — Step 3. A peer (the origin) invites one of OUR local users to a
   *  cross-server group. Friend-gated + idempotent mirror find-or-create, inside FederationService. */
  @Post('thread/invite')
  @HttpCode(HttpStatus.OK)
  async postThreadInvite(
    @Req() req: FastifyRequest,
  ): Promise<{ code: number; message: string; data: null }> {
    await this.federation.handleThreadInvite(req.body as S2SThreadInvite);
    return { code: BusinessCode.OK, message: 'ok', data: null };
  }

  @Get('users/:account')
  async getUserProfile(@Param('account') account: string) {
    // The endpoint serves OUR users only, so the domain is implicitly ours. The account is the sole
    // path segment — no `@`-joined address on the wire (the `@` is a UI input aid, split client-side).
    const address: S2SAddress = { account, domain: this.federation.ourDomain };
    const profile = await this.federation.getLocalUserProfile(address);
    if (!profile) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `user ${account} not found`,
        HttpStatus.NOT_FOUND,
      );
    }
    return profile;
  }

  @Get('users/:account/revision')
  async getUserRevision(@Param('account') account: string) {
    const address: S2SAddress = { account, domain: this.federation.ourDomain };
    const rev = await this.federation.getLocalUserRevision(address);
    if (!rev) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `user ${account} not found`,
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
    return this.federationBuffer.snapshotOutboundFor(
      this.signerDomain(req),
      cursor,
      take,
    );
  }

  /** GET /api/v1/s2s/messages — the peer pulls the SENDER's side of a 1:1 thread (authoritative,
   *  §3.2). `from` is OUR local user; `to` is the requester's user (the signer). Gate 2 (APPROVED
   *  friendship) is enforced inside serveOutboundMessages. */
  @Get('messages')
  async getMessages(
    @Req() req: FastifyRequest,
    @Query('from') fromAccount?: string,
    @Query('to') toAccount?: string,
    @Query('afterSeq') afterSeqParam?: string,
    @Query('take') takeParam?: string,
  ) {
    if (!fromAccount || !toAccount) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing from/to query param',
        HttpStatus.BAD_REQUEST,
      );
    }
    // 0-indexed seq: default afterSeq = -1 so a backfill (`>` -1) returns from seq 0. An explicit value
    // is the caller's last-seen seq (e.g. 0 → `>` 0 skips seq 0).
    const after = Number(afterSeqParam ?? '-1');
    if (Number.isNaN(after)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'afterSeq must be an integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    const take = Math.min(Number(takeParam ?? '50') || 50, 50);
    return this.federation.serveOutboundMessages(
      fromAccount,
      toAccount,
      this.signerDomain(req),
      after,
      take,
    );
  }

  /** GET /api/v1/s2s/messages/before — the BACKWARD twin of /messages (reserved for external/other
   *  federation implementations; SOMS's own transport is forward-only). `beforeSeq` is an exclusive
   *  upper bound (`seq < beforeSeq`); `< 0` (default) means no upper bound → the latest `take` messages.
   *  Returns the batch OLDEST-FIRST (descending query, reversed) so a caller prepends it directly; the
   *  next-older page uses `messages[0].originSeq` as the new `beforeSeq`. Same friendship gate. */
  @Get('messages/before')
  async getMessagesBefore(
    @Req() req: FastifyRequest,
    @Query('from') fromAccount?: string,
    @Query('to') toAccount?: string,
    @Query('beforeSeq') beforeSeqParam?: string,
    @Query('take') takeParam?: string,
  ) {
    if (!fromAccount || !toAccount) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing from/to query param',
        HttpStatus.BAD_REQUEST,
      );
    }
    // 0-indexed seq: default beforeSeq = -1 → no upper bound (the latest take messages).
    const beforeSeq = Number(beforeSeqParam ?? '-1');
    if (Number.isNaN(beforeSeq)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'beforeSeq must be an integer',
        HttpStatus.BAD_REQUEST,
      );
    }
    const take = Math.min(Number(takeParam ?? '50') || 50, 50);
    return this.federation.serveOutboundMessagesBefore(
      fromAccount,
      toAccount,
      this.signerDomain(req),
      beforeSeq,
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
    const body = req.body as
      | { origin?: unknown; entries?: unknown }
      | undefined;
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
      entries as ReadonlyArray<{
        from?: unknown;
        to?: unknown;
        latestSeq?: unknown;
      }>,
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

  /** GET /api/v1/s2s/get_file — stream a chat-media asset by sha256 digest (3-check authz, §3.3),
   *  with HTTP Range/206 support so the receiver fetches large files in resumable chunks (no whole-file
   *  buffer, no whole-transfer timeout). The receiver already knows the extension from the message
   *  content URL and re-serves same-origin via @fastify/static (ext→mime), so the S2S Content-Type is
   *  octet-stream (incidental). The 206 path uses `reply.hijack()` to bypass @fastify/compress (which
   *  would re-encode the body and break byte-exactness) + interceptors — same pattern as the SSE
   *  hijack in events.controller.ts. Authz (resolveMediaFile) runs before any bytes go out. */
  @Get('get_file')
  async getFile(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('digest') digest?: string,
    @Query('from') fromAccount?: string,
    @Query('to') toAccount?: string,
  ) {
    if (!digest || !fromAccount || !toAccount) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing digest/from/to query param',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { absPath, bytes } = await this.federation.resolveMediaFile(
      fromAccount,
      toAccount,
      this.signerDomain(req),
      digest,
    );
    const range = parseRange(req.headers.range, bytes);
    if (range === null) {
      // No Range (or unsupported form): serve the full file as 200. Advertise Accept-Ranges so a peer
      // that didn't ask this time knows it can next time.
      reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', String(bytes))
        .header('accept-ranges', 'bytes')
        .header('cache-control', 'no-store');
      return reply.send(createReadStream(absPath));
    }
    if (range === 'unsatisfiable') {
      reply
        .code(416)
        .header('content-range', `bytes */${bytes}`)
        .header('cache-control', 'no-store')
        .send();
      return;
    }
    // Single byte range → 206. Hijack the raw response: the byte-exact partial body MUST pass through
    // untouched (compress must not gzip it, interceptors must not touch it).
    reply.hijack();
    reply.raw.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(range.end - range.start + 1),
      'content-range': `bytes ${range.start}-${range.end}/${bytes}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    const fileStream = createReadStream(absPath, {
      start: range.start,
      end: range.end,
    });
    // Headers are already sent, so a read error mid-stream can't become a 5xx — just tear the socket
    // down. The receiver's digest check catches a truncated chunk and re-requests that range.
    fileStream.on('error', () => reply.raw.destroy());
    fileStream.pipe(reply.raw);
  }
}

/** Parse a single HTTP `Range: bytes=` request header against a known total size. Returns:
 *  - `{start,end}` for a single satisfiable byte range (server-side clamped to total-1, RFC 7233 §4.2);
 *  - `null` when there is no Range header, it isn't a `bytes=` range, or it's a multi-range list
 *    (unsupported here — the caller falls back to a full 200);
 *  - `'unsatisfiable'` when the range is syntactically valid but outside the resource (→ 416).
 *  Only the single-range forms the federation receiver emits are honored; anything else degrades
 *  gracefully to a full 200 rather than risking a mis-parsed slice. */
function parseRange(
  rangeHeader: string | string[] | undefined,
  total: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!Number.isFinite(total) || total <= 0) return null;
  const header = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader;
  if (!header) return null;
  const m = /^bytes=(.*)$/i.exec(header);
  if (!m) return null;
  const spec = m[1].trim();
  if (spec.includes(',')) return null; // multi-range unsupported → full 200
  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const left = spec.slice(0, dash);
  const right = spec.slice(dash + 1);
  let start: number;
  let end: number;
  if (left === '') {
    // Suffix form `bytes=-N` → last N bytes.
    const n = Number(right);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    const s = Number(left);
    if (!Number.isFinite(s) || s < 0 || !Number.isInteger(s)) return null;
    start = s;
    end =
      right === ''
        ? total - 1 // Open-ended `bytes=start-`
        : Math.min(Number(right), total - 1); // `bytes=start-end`, clamped
    if (!Number.isFinite(end) || !Number.isInteger(end)) return null;
  }
  if (start >= total || start > end) return 'unsatisfiable';
  return { start, end };
}
