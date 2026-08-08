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
import { createHash } from 'node:crypto';
import { S2sSignatureGuard } from './s2s-signature.guard.js';
import {
  FederationService,
  type S2SInvite,
  type S2SInviteAccept,
  type S2SInviteRevoke,
  type S2SCallFrame,
  type S2SAddress,
} from './federation.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { FederationMissedService } from './federation-missed.service.js';
import { FederationMissedPullService } from './federation-missed-pull.service.js';
import { FederationCursorService } from './federation-cursor.service.js';
import { SettingsService } from '../settings/settings.service.js';

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
    private readonly federationMissed: FederationMissedService,
    private readonly federationMissedPull: FederationMissedPullService,
    private readonly federationCursor: FederationCursorService,
    private readonly settings: SettingsService,
  ) {}

  /** Receive an ephemeral source HWM. Actual data remains pull-only through GET /missed. */
  @Post('discovery-hwm')
  @HttpCode(HttpStatus.ACCEPTED)
  async postDiscoveryHwm(@Req() req: FastifyRequest): Promise<void> {
    const signer = this.signerDomain(req);
    const body = req.body as {
      origin?: unknown;
      allocatedThrough?: unknown;
    };
    if (body.origin !== signer) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BINDING_VIOLATION,
        `origin (${String(body.origin)}) != signer (${signer})`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (
      typeof body.allocatedThrough !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(body.allocatedThrough)
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'allocatedThrough must be an unsigned decimal string',
        HttpStatus.BAD_REQUEST,
      );
    }
    this.federationMissedPull.advertise(signer, BigInt(body.allocatedThrough));
    // Wake-up is intentionally fire-and-forget: the durable cursor/page transaction owns recovery,
    // while this lightweight push returns promptly even when the peer has a large backlog.
    void this.federation
      .pullMissedFromPeer(this.federationMissedPull, signer)
      .catch(() => undefined);
  }

  /** Read our current source HWM for the signed peer; used after heartbeat recovery. */
  @Get('discovery-hwm')
  async getDiscoveryHwm(@Req() req: FastifyRequest) {
    const allocatedThrough = await this.federationCursor.readAllocatedThrough(
      this.signerDomain(req),
    );
    return { allocatedThrough: allocatedThrough.toString() };
  }

  /** Durable cross-thread feed. changeId values stay decimal strings on the JSON wire. */
  @Get('missed')
  async getMissed(
    @Req() req: FastifyRequest,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
  ) {
    const after = this.parseUnsignedBigInt(afterParam, 'after');
    const take = takeParam === undefined ? undefined : Number(takeParam);
    return this.federationMissed.serve(this.signerDomain(req), after, take);
  }

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

  @Post('invite-revoke')
  @HttpCode(HttpStatus.ACCEPTED)
  async postInviteRevoke(@Req() req: FastifyRequest): Promise<void> {
    await this.federation.handleInviteRevoke(req.body as S2SInviteRevoke);
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
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `user ${account} not found`,
      );
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
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `user ${account} not found`,
      );
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
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `group ${account} not found`,
      );
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
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `group ${account} not found`,
      );
    }
    return roster;
  }

  /** Authoritative current relationship check. `localAccount` beginning with `!` addresses a group;
   * otherwise it addresses this server's user in a P2P relationship with `peerAccount` on the signer. */
  @Get('thread-access')
  async getThreadAccess(
    @Req() req: FastifyRequest,
    @Query('localAccount') localAccount?: string,
    @Query('peerAccount') peerAccount?: string,
  ) {
    if (!localAccount) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing localAccount query param',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!localAccount.startsWith('!') && !peerAccount) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing peerAccount query param',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.federation.queryThreadAccess(
      localAccount,
      peerAccount,
      this.signerDomain(req),
    );
  }

  /** The verified signer domain (set by S2sSignatureGuard as req.peer.domain). */
  private signerDomain(req: FastifyRequest): string {
    return (req as FastifyRequest & { peer: { domain: string } }).peer.domain;
  }

  private parseUnsignedBigInt(value: string | undefined, name: string): bigint {
    if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `${name} must be an unsigned decimal integer`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return BigInt(value);
  }

  /** Binding-check `toDomain` (the REQUESTER's asserted domain) against the RFC 9421 signer — belt-and-
   *  suspenders over the signature, matching the binding checks on other signed S2S endpoints. The
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
    const domain = this.signerDomain(req);
    await this.federation.markRecovered(domain);
    await this.federation.markContactSuccess(domain);
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
    @Query('seq') seqParam?: string,
    @Query('bundleId') bundleId?: string,
  ) {
    const signer = this.signerDomain(req);
    this.requireBinding(toDomain, signer);
    const seq = Number(seqParam);
    if (
      !digest ||
      !fromAccount ||
      !fromDomain ||
      !toAccount ||
      !Number.isInteger(seq) ||
      seq < 0
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing or invalid message media authorization query params',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { absPath, bytes } = await this.federation.resolveMediaFile(
      fromAccount,
      toAccount,
      fromDomain,
      signer,
      digest,
      seq,
      bundleId,
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
    // Optional extra integrity signal. It costs an additional disk pass, so NAS deployments default it
    // off. Receivers always verify a supplied value and still verify the final whole-file CAS digest.
    let chunkDigest: string | undefined;
    if (await this.settings.isFederationChunkDigestEnabled()) {
      const chunkHash = createHash('sha256');
      for await (const piece of createReadStream(absPath, {
        start: range.start,
        end: range.end,
      })) {
        chunkHash.update(piece);
      }
      chunkDigest = `sha-256=${chunkHash.digest('base64')}`;
    }
    // Single byte range → 206. Hijack the raw response: the byte-exact partial body MUST pass through
    // untouched (compress must not gzip it, interceptors must not touch it).
    reply.hijack();
    reply.raw.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(range.end - range.start + 1),
      'content-range': `bytes ${range.start}-${range.end}/${bytes}`,
      ...(chunkDigest ? { 'content-digest': chunkDigest } : {}),
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

  /** JSONB is serialized as ordinary UTF-8 application/json. The response contains the root plus the
   * complete child-bundle closure; binary assets remain resumable /get_file transfers. */
  @Get('forward-bundles/:bundleId')
  getForwardBundle(
    @Req() req: FastifyRequest,
    @Param('bundleId') bundleId: string,
  ) {
    return this.federation.serveForwardBundleClosure(
      bundleId,
      this.signerDomain(req),
    );
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
