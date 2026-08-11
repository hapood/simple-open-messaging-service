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
  type S2SCallFrame,
  type S2SAddress,
} from './federation.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { FederationMessageFeedService } from './federation-message-feed.service.js';
import { FederationMessageFeedPullService } from './federation-message-feed-pull.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';
import { PeerStateFeedPullService } from './peer-state-feed-pull.service.js';
import { FEDERATION_API_PREFIX } from './federation-protocol.js';

/**
 * S2S endpoints (signature-guarded, allow-list gated). The guard verifies the RFC 9421 signature +
 * FederatedPeer trust + request integrity + captures req.rawBody, then sets req.peer.
 *
 * - POST /s2s/v1/call — a federated 1:1 WebRTC call frame (ring / lifecycle / SDP-ICE relay); FederationService.handleCallFrame.
 * - GET  /s2s/v1/state-feed — compacted profile/relationship/group state for the signed peer.
 * - GET  /s2s/v1/message-feed — durable message-discovery changes for the signed peer.
 * - POST /s2s/v1/feed-revisions — ephemeral state/message revision wake-up hint.
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
@Controller(FEDERATION_API_PREFIX)
@UseGuards(S2sSignatureGuard)
export class S2sController {
  constructor(
    private readonly federation: FederationService,
    private readonly messageFeed: FederationMessageFeedService,
    private readonly messageFeedPull: FederationMessageFeedPullService,
    private readonly settings: SettingsService,
    private readonly peerStateFeed: PeerStateFeedService,
    private readonly peerStateFeedPull: PeerStateFeedPullService,
  ) {}

  /** Receive ephemeral state/miss source HWMs; actual data remains pull-only. */
  @Post('feed-revisions')
  @HttpCode(HttpStatus.ACCEPTED)
  async postDiscoveryHwm(@Req() req: FastifyRequest): Promise<void> {
    const signer = this.signerDomain(req);
    const body = req.body as {
      origin?: unknown;
      stateFeedRev?: unknown;
      messageFeedRev?: unknown;
    };
    if (body.origin !== signer) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BINDING_VIOLATION,
        `origin (${String(body.origin)}) != signer (${signer})`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (
      typeof body.stateFeedRev !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(body.stateFeedRev) ||
      typeof body.messageFeedRev !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(body.messageFeedRev)
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'stateFeedRev and messageFeedRev must be unsigned decimal strings',
        HttpStatus.BAD_REQUEST,
      );
    }
    this.peerStateFeedPull.advertise(signer, BigInt(body.stateFeedRev));
    this.messageFeedPull.advertise(signer, BigInt(body.messageFeedRev));
    // Wake-up is intentionally fire-and-forget: the durable cursor/page transaction owns recovery,
    // while this lightweight push returns promptly even when the peer has a large backlog.
    void this.federation
      .pullStateFromPeer(signer)
      .then(() =>
        this.federation.pullMissedFromPeer(this.messageFeedPull, signer),
      )
      .catch(() => undefined);
  }

  /** Durable cross-thread feed. changeId values stay decimal strings on the JSON wire. */
  @Get('message-feed')
  async getMissed(
    @Req() req: FastifyRequest,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
  ) {
    const after = this.parseUnsignedBigInt(afterParam, 'after');
    const take = takeParam === undefined ? undefined : Number(takeParam);
    return this.messageFeed.serve(this.signerDomain(req), after, take);
  }

  @Get('state-feed')
  async getStateFeed(
    @Req() req: FastifyRequest,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
  ) {
    const after = this.parseUnsignedBigInt(afterParam, 'after');
    const take = takeParam === undefined ? undefined : Number(takeParam);
    return this.peerStateFeed.serve(this.signerDomain(req), after, take);
  }

  @Post('call')
  @HttpCode(HttpStatus.OK)
  async postCall(@Req() req: FastifyRequest): Promise<null> {
    // handleCallFrame is awaitable + emits the frame to CallsService via emitAsync before returning,
    // so the 200 serializes behind the callee-side mirror setup (the caller's first `offer` cannot
    // win the race against the mirror it addresses).
    await this.federation.handleCallFrame(
      req.body as S2SCallFrame,
      this.signerDomain(req),
      req.peer!.signatureExpiresAtSec,
    );
    return null;
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

  /** GET /s2s/v1/media/:digest — stream a chat-media asset by sha256 digest,
   *  with HTTP Range/206 support so the receiver fetches large files in resumable chunks (no whole-file
   *  buffer, no whole-transfer timeout). The receiver already knows the extension from the message
   *  content URL and re-serves same-origin via @fastify/static (ext→mime), so the S2S Content-Type is
   *  octet-stream (incidental). The 206 path uses `reply.hijack()` to bypass @fastify/compress (which
   *  would re-encode the body and break byte-exactness) + interceptors — same pattern as the SSE
   *  hijack in events.controller.ts. Authz (resolveMediaFile) runs before any bytes go out. */
  @Raw() // binary octet-stream via reply.hijack — stays outside the ApiResult envelope; its errors keep HTTP status (the client classifies by status).
  @Get('media/:digest')
  async getFile(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('digest') digest?: string,
    @Query('fromAccount') fromAccount?: string,
    @Query('fromDomain') fromDomain?: string,
    @Query('toAccount') toAccount?: string,
    @Query('seq') seqParam?: string,
    @Query('bundleId') bundleId?: string,
  ) {
    const signer = this.signerDomain(req);
    const seq = Number(seqParam);
    if (
      !digest ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !fromAccount ||
      !fromDomain ||
      !toAccount ||
      !Number.isInteger(seq) ||
      seq < 0
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'missing or invalid message media authorization parameters',
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
      chunkDigest = `sha-256=:${chunkHash.digest('base64')}:`;
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
   * complete child-bundle closure; binary assets remain resumable /media/:digest transfers. */
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
