import { Public } from '../common/public.decorator.js';
import { Raw } from '../common/raw.decorator.js';
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
import {
  FederationService,
  type S2SInvite,
  type S2SInviteAccept,
  type S2SCallFrame,
  type S2SAddress,
} from './federation.service.js';
import { FederationBufferService } from './federation-buffer.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * S2S endpoints (signature-guarded, allow-list gated). The guard verifies the RFC 9421 signature +
 * FederatedPeer trust + from.domain==signer binding + captures req.rawBody, then sets req.peer.
 *
 * - POST /api/v1/s2s/invite — receive an invite (friend OR group, unified); FederationService.handleInvite.
 * - POST /api/v1/s2s/invite-accept — the peer accepted an invite (friend→P2P thread; group→origin records the join).
 * - POST /api/v1/s2s/call — a federated 1:1 WebRTC call frame (ring / lifecycle / SDP-ICE relay); FederationService.handleCallFrame.
 * - GET  /api/v1/s2s/users/:account — return a local user's public profile (avatar inline as base64).
 * - GET  /api/v1/s2s/users/:account/revision — lightweight profile-revision probe (no avatar transfer).
 *
 * NOTE: there is no unfriend/member-delete endpoint — those are LOCAL-ONLY. A severed edge / left member
 * is discovered lazily via rejection-on-send in Step 2.
 *
 * Response shape: success bodies are enveloped by the global SerializeInterceptor as
 * { code: 0, message, data } (the peer's getSigned unwraps `data` and throws on a non-zero code). Business
 * outcomes (a lookup target that doesn't exist) are HTTP 200 + code NOT_FOUND — same envelope, non-zero
 * code — NOT an HTTP 404; only the protocol/security layer keeps its HTTP status (401 binding mismatch,
 * 410 group-author-left, 400 malformed params, 5xx). getFile is the one exception: it is @Raw (binary
 * octet-stream via reply.hijack) and its errors keep their HTTP status because its client classifies by
 * status. RFC 9421 request-signing covers the REQUEST (which is unchanged); response bodies are not signed.
 */
@Public()
@Controller('s2s')
@UseGuards(S2sSignatureGuard)
export class S2sController {
  constructor(
    private readonly federation: FederationService,
    private readonly federationBuffer: FederationBufferService,
  ) {}

  @Post('invite')
  @HttpCode(HttpStatus.ACCEPTED)
  async postInvite(@Req() req: FastifyRequest): Promise<void> {
    await this.federation.handleInvite(req.body as S2SInvite);
  }

  @Post('invite-accept')
  @HttpCode(HttpStatus.ACCEPTED)
  async postInviteAccept(@Req() req: FastifyRequest): Promise<void> {
    await this.federation.handleInviteAccept(req.body as S2SInviteAccept);
  }

  @Post('call')
  @HttpCode(HttpStatus.ACCEPTED)
  async postCall(@Req() req: FastifyRequest): Promise<void> {
    // handleCallFrame is awaitable + emits the frame to CallsService via emitAsync before returning,
    // so the 202 serializes behind the callee-side mirror setup (the caller's first `offer` cannot
    // win the race against the mirror it addresses).
    await this.federation.handleCallFrame(req.body as S2SCallFrame);
  }

  @Get('users/:account')
  async getUserProfile(@Param('account') account: string) {
    // The endpoint serves OUR users only, so the domain is implicitly ours. The account is the sole
    // path segment — no `@`-joined address on the wire (the `@` is a UI input aid, split client-side).
    const address: S2SAddress = { account, domain: this.federation.ourDomain };
    const profile = await this.federation.getLocalUserProfile(address);
    if (!profile) {
      // HTTP 200 + code NOT_FOUND (a missing lookup target is a business outcome, not a protocol 404);
      // the global AllExceptionsFilter renders the envelope. The peer's getSigned detects the non-zero code.
      throw new BusinessException(BusinessCode.NOT_FOUND, `user ${account} not found`);
    }
    return profile;
  }

  @Get('users/:account/revision')
  async getUserRevision(@Param('account') account: string) {
    const address: S2SAddress = { account, domain: this.federation.ourDomain };
    const rev = await this.federation.getLocalUserRevision(address);
    if (!rev) {
      // HTTP 200 + code NOT_FOUND (a missing lookup target is a business outcome, not a protocol 404);
      // the global AllExceptionsFilter renders the envelope. The peer's getSigned detects the non-zero code.
      throw new BusinessException(BusinessCode.NOT_FOUND, `user ${account} not found`);
    }
    return rev;
  }

  /** GET /api/v1/s2s/group/:account/roster-revision — a member-server probes the origin's roster
   *  revision for a federated group (the lazy roster meta-pull on chat-open). Symmetric with the profile
   *  /users/:account/revision probe. The group is addressed by its `!account`. */
  @Get('group/:account/roster-revision')
  async getGroupRosterRevision(@Param('account') account: string) {
    const rev = await this.federation.getLocalGroupRosterRevision(account);
    if (!rev) {
      // HTTP 200 + code NOT_FOUND (a missing lookup target is a business outcome, not a protocol 404);
      // the global AllExceptionsFilter renders the envelope. The peer's getSigned detects the non-zero code.
      throw new BusinessException(BusinessCode.NOT_FOUND, `group ${account} not found`);
    }
    return rev;
  }

  /** GET /api/v1/s2s/group/:account/roster — a member-server pulls the canonical roster for a
   *  federated group (the lazy meta-pull on chat-open). The group is addressed by its `!account` path
   *  param (no internal thread id on the wire) — a sibling of /group/:account/roster-revision. The
   *  signer is a trusted peer (S2sSignatureGuard). */
  @Get('group/:account/roster')
  async getGroupRoster(@Param('account') account: string) {
    const roster = await this.federation.serveGroupRoster(account);
    if (roster === null) {
      // HTTP 200 + code NOT_FOUND (a missing lookup target is a business outcome, not a protocol 404);
      // the global AllExceptionsFilter renders the envelope. The peer's getSigned detects the non-zero code.
      throw new BusinessException(BusinessCode.NOT_FOUND, `group ${account} not found`);
    }
    return roster;
  }

  // ─── Step 2: coalesced hint map + message pull (serving side) ────────────────

  /** GET /api/v1/s2s/new-msg-map — the peer pulls OUR outbound hint entries (the one-directional
   *  fallback, §4.3). Non-destructive: we serve a snapshot; entries leave only on a successful PUSH ack.
   *  The requester is the signing server (req.peer.domain). */
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

  /** GET /api/v1/s2s/messages — the peer pulls messages. Three shapes, all account-based (no internal
   *  thread id): `toAccount` is a peer user (P2P, `fromAccount` = our local sender) or the group
   *  `!account` (group). For a group: `fromAccount` absent → ALL-SENDERS whole-thread pull (mirror ←
   *  origin, keyed by thread seq, advances the mirror's pullUntil); `fromAccount` present → PER-AUTHOR
   *  pull (origin ← mirror hub leg, keyed by originSeq). `fromDomain` is the author's domain (required
   *  for group; for P2P it is our own). `toDomain` is the REQUESTER's domain (== the signature signer;
   *  binding-checked). Gates (friendship / roster) are enforced inside the serve* methods. */
  @Get('messages')
  async getMessages(
    @Req() req: FastifyRequest,
    @Query('fromAccount') fromAccount?: string,
    @Query('fromDomain') fromDomain?: string,
    @Query('toAccount') toAccount?: string,
    @Query('toDomain') toDomain?: string,
    @Query('afterSeq') afterSeqParam?: string,
    @Query('take') takeParam?: string,
  ) {
    const signer = this.signerDomain(req);
    this.requireBinding(toDomain, signer);
    if (!toAccount) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing toAccount query param',
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
    if (toAccount.startsWith('!')) {
      // Group: all-senders (mirror ← origin) when no `fromAccount`; per-author (origin ← mirror) when present.
      if (fromAccount && fromDomain) {
        return this.federation.serveOutboundMessagesGroupFrom(
          toAccount,
          fromAccount,
          fromDomain,
          after,
          take,
          signer,
        );
      }
      return this.federation.serveOutboundMessagesGroup(toAccount, after, take, signer);
    }
    // P2P: `fromAccount` is our local sender, `toAccount` is the requester's user. Friendship gate inside.
    if (!fromAccount) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing fromAccount query param',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.federation.serveOutboundMessages(
      fromAccount,
      toAccount,
      signer,
      after,
      take,
    );
  }

  /** GET /api/v1/s2s/messages/before — the BACKWARD twin of /messages (reserved for external/other
   *  federation implementations; SOMS's own transport is forward-only). `beforeSeq` is an exclusive
   *  upper bound (`seq < beforeSeq`); `< 0` (default) means no upper bound → the latest `take` messages.
   *  Returns the batch OLDEST-FIRST (descending query, reversed) so a caller prepends it directly. The
   *  next-older page uses `messages[0].originSeq`/`messages[0].seq` as the new `beforeSeq`. THREE shapes,
   *  symmetric with /messages: P2P (`fromAccount`+`toAccount`), group all-senders (`toAccount=!group`),
   *  group per-author (`toAccount=!group`+`fromAccount`+`fromDomain`, carries the {code:50010} leave
   *  signal). Same gates (friendship / roster) as the forward leg. */
  @Get('messages/before')
  async getMessagesBefore(
    @Req() req: FastifyRequest,
    @Query('fromAccount') fromAccount?: string,
    @Query('fromDomain') fromDomain?: string,
    @Query('toAccount') toAccount?: string,
    @Query('toDomain') toDomain?: string,
    @Query('beforeSeq') beforeSeqParam?: string,
    @Query('take') takeParam?: string,
  ) {
    const signer = this.signerDomain(req);
    this.requireBinding(toDomain, signer);
    if (!toAccount) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing toAccount query param',
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
    if (toAccount.startsWith('!')) {
      // Group: all-senders when no `fromAccount`; per-author (with the {code:50010} leave signal) when present.
      if (fromAccount && fromDomain) {
        return this.federation.serveOutboundMessagesGroupFromBefore(
          toAccount,
          fromAccount,
          fromDomain,
          beforeSeq,
          take,
          signer,
        );
      }
      return this.federation.serveOutboundMessagesGroupBefore(toAccount, beforeSeq, take, signer);
    }
    // P2P: `fromAccount` is our local sender, `toAccount` is the requester's user. Friendship gate inside.
    if (!fromAccount) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing fromAccount query param',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.federation.serveOutboundMessagesBefore(
      fromAccount,
      toAccount,
      signer,
      beforeSeq,
      take,
    );
  }

  /** POST /api/v1/s2s/new-msg-map — a peer pushes ITS outbound hint entries (dirty conversations) to us.
   *  Validate `origin === signer` (belt-and-suspenders over the signature), then enqueue + drain. ACKs
   *  fast (202 Accepted — the actual message pull runs out of band). */
  @Post('new-msg-map')
  @HttpCode(HttpStatus.ACCEPTED)
  async postNewMsgMap(@Req() req: FastifyRequest): Promise<void> {
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
        fromAccount?: unknown;
        fromDomain?: unknown;
        toAccount?: unknown;
        latestSeq?: unknown;
      }>,
    );
  }

  /** The verified signer domain (set by S2sSignatureGuard as req.peer.domain). */
  private signerDomain(req: FastifyRequest): string {
    return (req as FastifyRequest & { peer: { domain: string } }).peer.domain;
  }

  /** Binding-check `toDomain` (the REQUESTER's asserted domain) against the RFC 9421 signer — belt-and-
   *  suspenders over the signature, same pattern as the `origin === signer` check in POST /new-msg-map. The
   *  signature proves only the signer DOMAIN (not a specific user), so the requester explicitly asserts
   *  which domain `toAccount` lives on and we enforce it matches the cryptographic identity. */
  private requireBinding(toDomain: string | undefined, signer: string): void {
    if (!toDomain) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing toDomain query param',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (toDomain !== signer) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BINDING_VIOLATION,
        `toDomain (${toDomain}) != signer (${signer})`,
        HttpStatus.UNAUTHORIZED,
      );
    }
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
  @Raw() // binary octet-stream via reply.hijack — stays outside the ApiResult envelope; its errors keep HTTP status (the client classifies by status).
  @Get('get_file')
  async getFile(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('digest') digest?: string,
    @Query('fromAccount') fromAccount?: string,
    @Query('fromDomain') fromDomain?: string,
    @Query('toAccount') toAccount?: string,
    @Query('toDomain') toDomain?: string,
  ) {
    const signer = this.signerDomain(req);
    this.requireBinding(toDomain, signer);
    if (!digest || !fromAccount || !toAccount) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing digest/fromAccount/toAccount query param',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { absPath, bytes } = await this.federation.resolveMediaFile(
      fromAccount,
      toAccount,
      fromDomain,
      signer,
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
