import { Public } from '../common/public.decorator.js';
import { Raw } from '../common/raw.decorator.js';
import {
  Controller,
  Get,
  Post,
  HttpCode,
  HttpStatus,
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
import { FederationMessageTombstoneFeedService } from './federation-message-tombstone-feed.service.js';
import { FederationMessageTombstonePullService } from './federation-message-tombstone-pull.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';
import { PeerStateFeedPullService } from './peer-state-feed-pull.service.js';
import { FEDERATION_API_PREFIX } from './federation-protocol.js';
import {
  parseFederationResourceRequest,
  parseFederationRange,
  requireAccount,
  requireBundleId,
  requireDomain,
  requireSafeDecimal,
  requireSha256Hex,
  requireUserAccount,
} from './federation-resource-request.js';

/**
 * S2S endpoints (signature-guarded, allow-list gated). The guard verifies the RFC 9421 signature +
 * FederatedPeer trust + request integrity + captures req.rawBody, then sets req.peer.
 *
 * - POST /s2s/v1/call — a federated 1:1 WebRTC call frame (ring / lifecycle / SDP-ICE relay); FederationService.handleCallFrame.
 * - GET  /s2s/v1/state-feed — compacted profile/relationship/group state for the signed peer.
 * - GET  /s2s/v1/message-feed — durable message-discovery changes for the signed peer.
 * - POST /s2s/v1/feed-heads — ephemeral state/message/tombstone feed-head wake-up hint.
 *
 * Response shape: success bodies are enveloped by the global SerializeInterceptor as
 * { code: 0, message, data } (the peer's getSigned unwraps `data` and throws on a non-zero code). Business
 * outcomes (a lookup target that doesn't exist) are HTTP 200 + code NOT_FOUND — same envelope, non-zero
 * code — NOT an HTTP 404; only the protocol/security layer keeps its registered HTTP status (400, 401,
 * 409, 503). getFile is the raw-body exception: successful media is binary 200/206 and an unsatisfiable
 * Range is JSON 416, while ordinary business errors remain JSON HTTP 200. RFC 9421 request-signing covers
 * the REQUEST (which is unchanged); response bodies are not signed.
 */
@Public()
@Controller(FEDERATION_API_PREFIX)
@UseGuards(S2sSignatureGuard)
export class S2sController {
  constructor(
    private readonly federation: FederationService,
    private readonly messageFeed: FederationMessageFeedService,
    private readonly messageFeedPull: FederationMessageFeedPullService,
    private readonly tombstoneFeed: FederationMessageTombstoneFeedService,
    private readonly tombstonePull: FederationMessageTombstonePullService,
    private readonly settings: SettingsService,
    private readonly peerStateFeed: PeerStateFeedService,
    private readonly peerStateFeedPull: PeerStateFeedPullService,
  ) {}

  /** Receive ephemeral state/message/tombstone feed heads; actual data remains pull-only. */
  @Post('feed-heads')
  @HttpCode(HttpStatus.OK)
  async postDiscoveryHwm(@Req() req: FastifyRequest): Promise<void> {
    const signer = this.signerDomain(req);
    const body = req.body as {
      origin?: unknown;
      stateFeedEndId?: unknown;
      messageFeedEndId?: unknown;
      tombstoneFeedEndId?: unknown;
    };
    if (body.origin !== signer) {
      throw new BusinessException(
        BusinessCode.FEDERATION_BINDING_VIOLATION,
        `origin (${String(body.origin)}) != signer (${signer})`,
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (
      typeof body.stateFeedEndId !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(body.stateFeedEndId) ||
      typeof body.messageFeedEndId !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(body.messageFeedEndId) ||
      typeof body.tombstoneFeedEndId !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(body.tombstoneFeedEndId)
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'feed end IDs must be unsigned decimal strings',
        HttpStatus.BAD_REQUEST,
      );
    }
    const stateFeedEndId = BigInt(body.stateFeedEndId);
    const messageFeedEndId = BigInt(body.messageFeedEndId);
    const tombstoneFeedEndId = BigInt(body.tombstoneFeedEndId);
    this.peerStateFeedPull.advertise(signer, stateFeedEndId);
    this.messageFeedPull.advertise(signer, messageFeedEndId, stateFeedEndId);
    this.tombstonePull.advertise(signer, tombstoneFeedEndId, stateFeedEndId);
    // Wake-up is intentionally fire-and-forget: the durable cursor/page transaction owns recovery,
    // while this lightweight push returns promptly even when the peer has a large backlog.
    void this.federation
      .pullStateFromPeer(signer, stateFeedEndId)
      .then(() =>
        this.federation.pullTombstonesFromPeer(signer, stateFeedEndId),
      )
      .then(() =>
        this.federation.pullMissedFromPeer(
          this.messageFeedPull,
          signer,
          stateFeedEndId,
        ),
      )
      .catch(() => undefined);
  }

  @Get('message-tombstone-feed')
  async getMessageTombstones(
    @Req() req: FastifyRequest,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
    @Query('through') throughParam?: string,
  ) {
    this.assertQueryShape(req, ['after', 'take', 'through']);
    const peerDomain = this.signerDomain(req);
    if (afterParam === undefined) {
      if (takeParam !== undefined || throughParam !== undefined) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'take and through require after',
          HttpStatus.BAD_REQUEST,
        );
      }
      return this.tombstoneFeed.rejectMissingAfter(peerDomain);
    }
    const after = this.parseCursorBigInt(afterParam, 'after');
    const take =
      takeParam === undefined
        ? undefined
        : this.parsePositiveSafeIntegerQuery(takeParam, 'take');
    const through =
      throughParam === undefined
        ? undefined
        : this.parseCursorBigInt(throughParam, 'through');
    return this.tombstoneFeed.serve(peerDomain, after, take, through);
  }

  /** Durable cross-thread feed. feedId values stay decimal strings on the JSON wire. */
  @Get('message-feed')
  async getMissed(
    @Req() req: FastifyRequest,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
    @Query('through') throughParam?: string,
    @Query('excludeSelf') excludeSelfParam?: string,
  ) {
    this.assertQueryShape(req, ['after', 'take', 'through', 'excludeSelf']);
    const peerDomain = this.signerDomain(req);
    if (afterParam === undefined) {
      if (
        takeParam !== undefined ||
        throughParam !== undefined ||
        excludeSelfParam !== undefined
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'take, through and excludeSelf require after',
          HttpStatus.BAD_REQUEST,
        );
      }
      return this.messageFeed.rejectMissingAfter(peerDomain);
    }
    const after = this.parseCursorBigInt(afterParam, 'after');
    const take =
      takeParam === undefined
        ? undefined
        : this.parsePositiveSafeIntegerQuery(takeParam, 'take');
    const through =
      throughParam === undefined
        ? undefined
        : this.parseCursorBigInt(throughParam, 'through');
    const excludeSelf = this.parseOptionalBoolean(
      excludeSelfParam,
      'excludeSelf',
    );
    return this.messageFeed.serve(
      peerDomain,
      after,
      take,
      through,
      excludeSelf,
    );
  }

  @Get('state-feed')
  async getStateFeed(
    @Req() req: FastifyRequest,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
    @Query('through') throughParam?: string,
  ) {
    this.assertQueryShape(req, ['after', 'take', 'through']);
    const peerDomain = this.signerDomain(req);
    if (afterParam === undefined) {
      if (takeParam !== undefined || throughParam !== undefined) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'take and through require after',
          HttpStatus.BAD_REQUEST,
        );
      }
      return this.peerStateFeed.rejectMissingAfter(peerDomain);
    }
    const after = this.parseCursorBigInt(afterParam, 'after');
    const take = takeParam === undefined ? undefined : Number(takeParam);
    const through =
      throughParam === undefined
        ? undefined
        : this.parseCursorBigInt(throughParam, 'through');
    return this.peerStateFeed.serve(peerDomain, after, take, through);
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
  async getUserProfile(@Req() req: FastifyRequest) {
    const parsed = parseFederationResourceRequest(req, {
      pathPrefix: '/s2s/v1/users/',
      pathName: 'account',
    });
    const account = requireUserAccount(parsed.pathValue, 'account');
    // The endpoint serves OUR users only, so the domain is implicitly ours. The account is the sole
    // path segment — no `@`-joined address on the wire (the `@` is a UI input aid, split client-side).
    const address: S2SAddress = { account, domain: this.federation.ourDomain };
    const profile = await this.resourceOperation(() =>
      this.federation.getLocalUserProfile(address),
    );
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

  private assertQueryShape(req: FastifyRequest, allowedFields: string[]): void {
    const query = req.query as Record<string, unknown>;
    const allowed = new Set(allowedFields);
    if (
      !query ||
      typeof query !== 'object' ||
      Array.isArray(query) ||
      Object.keys(query).some((field) => !allowed.has(field)) ||
      Object.values(query).some((value) => typeof value !== 'string')
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'query contains unknown or repeated fields',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private parseCursorBigInt(value: string | undefined, name: string): bigint {
    if (value === undefined || !/^(0|-?[1-9]\d*)$/.test(value)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `${name} must be a canonical decimal integer`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return BigInt(value);
  }

  private parsePositiveSafeIntegerQuery(value: string, name: string): number {
    if (!/^[1-9]\d*$/.test(value)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `${name} must be a canonical positive integer`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `${name} must be a positive safe integer`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return parsed;
  }

  private parseOptionalBoolean(
    value: string | undefined,
    name: string,
  ): boolean {
    if (value === undefined || value === 'false') return false;
    if (value === 'true') return true;
    throw new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      `${name} must be true or false`,
      HttpStatus.BAD_REQUEST,
    );
  }

  /** GET /s2s/v1/media/:digest — stream a chat-media asset by sha256 digest,
   *  with HTTP Range/206 support so the receiver fetches large files in resumable chunks (no whole-file
   *  buffer, no whole-transfer timeout). The receiver already knows the extension from the message
   *  content URL and re-serves same-origin via @fastify/static (ext→mime), so the S2S Content-Type is
   *  octet-stream (incidental). The 206 path uses `reply.hijack()` to bypass @fastify/compress (which
   *  would re-encode the body and break byte-exactness) + interceptors — same pattern as the SSE
   *  hijack in events.controller.ts. Authz (resolveMediaFile) runs before any bytes go out. */
  @Raw() // Successful bodies bypass ApiResult; pre-stream BusinessException responses still use their registered JSON status/code.
  @Get('media/:digest')
  async getFile(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const parsed = parseFederationResourceRequest(req, {
      pathPrefix: '/s2s/v1/media/',
      pathName: 'digest',
      query: [
        { name: 'fromAccount' },
        { name: 'fromDomain' },
        { name: 'toAccount' },
        { name: 'seq' },
        { name: 'bundleId', optional: true },
      ],
    });
    const digest = requireSha256Hex(parsed.pathValue, 'digest');
    const fromAccount = requireUserAccount(
      parsed.query.fromAccount,
      'fromAccount',
    );
    const fromDomain = requireDomain(parsed.query.fromDomain, 'fromDomain');
    const toAccount = requireAccount(parsed.query.toAccount, 'toAccount');
    const seq = requireSafeDecimal(parsed.query.seq, 'seq');
    const bundleId =
      parsed.query.bundleId === undefined
        ? undefined
        : requireBundleId(parsed.query.bundleId);
    const signer = this.signerDomain(req);
    const { absPath, bytes } = await this.resourceOperation(() =>
      this.federation.resolveMediaFile(
        fromAccount,
        toAccount,
        fromDomain,
        signer,
        digest,
        seq,
        bundleId,
      ),
    );
    const range = parseFederationRange(req.headers.range, bytes);
    if (range.kind === 'none') {
      // No Range: serve the full file as 200. Advertise Accept-Ranges so a peer that didn't ask this
      // time knows it can next time.
      reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', String(bytes))
        .header('accept-ranges', 'bytes')
        .header('cache-control', 'no-store');
      return reply.send(createReadStream(absPath));
    }
    if (range.kind === 'malformed') {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'Range must be one valid bytes range',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (range.kind === 'unsatisfiable') {
      reply
        .code(416)
        .header('content-type', 'application/json')
        .header('content-range', `bytes */${bytes}`)
        .header('cache-control', 'no-store')
        .send({
          code: BusinessCode.FEDERATION_RANGE_NOT_SATISFIABLE,
          message: 'requested range is not satisfiable',
          data: null,
        });
      return;
    }
    // Optional extra integrity signal. It costs an additional disk pass, so NAS deployments default it
    // off. Receivers always verify a supplied value and still verify the final whole-file CAS digest.
    const chunkDigest = await this.resourceOperation(async () => {
      if (!(await this.settings.isFederationChunkDigestEnabled())) {
        return undefined;
      }
      const chunkHash = createHash('sha256');
      for await (const piece of createReadStream(absPath, {
        start: range.start,
        end: range.end,
      })) {
        chunkHash.update(piece);
      }
      return `sha-256=:${chunkHash.digest('base64')}:`;
    });
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
  async getForwardBundle(@Req() req: FastifyRequest) {
    const parsed = parseFederationResourceRequest(req, {
      pathPrefix: '/s2s/v1/forward-bundles/',
      pathName: 'bundleId',
    });
    const bundleId = requireBundleId(parsed.pathValue);
    return this.resourceOperation(() =>
      this.federation.serveForwardBundleClosure(
        bundleId,
        this.signerDomain(req),
      ),
    );
  }

  /** Resource operations expose only the v1 service-unavailable status for failures whose resource
   * state could not be determined. Known BusinessException outcomes retain their exact status/code. */
  private async resourceOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BusinessException) throw error;
      throw new BusinessException(
        BusinessCode.INTERNAL,
        'federation resource temporarily unavailable',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
