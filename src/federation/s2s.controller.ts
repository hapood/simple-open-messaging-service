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
import { FederationService, type S2SAddress } from './federation.service.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { FederationMessageFeedService } from './federation-message-feed.service.js';
import { FederationMessageTombstoneFeedService } from './federation-message-tombstone-feed.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';
import { ProfileNamespaceFeedService } from './profile-namespace-feed.service.js';
import { FederationProfileNamespacePullService } from './federation-profile-namespace-pull.service.js';
import { FederationGroupMetaFeedService } from './group-meta-feed.service.js';
import { KeypairService } from './keypair.service.js';
import { FEDERATION_API_PREFIX } from './federation-protocol.js';
import { FEDERATION_THREAD_SEQUENCE_MAX } from './federation-thread-round.constants.js';
import { FederationThreadRoundSchedulerService } from './federation-thread-round-scheduler.service.js';
import {
  parseFederationResourceRequest,
  parseFederationResourcePath,
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
 * Active namespace trust + request integrity + captures req.rawBody, then sets req.peer.
 *
 * - POST /s2s/v1/call — a federated 1:1 WebRTC call frame (ring / lifecycle / SDP-ICE relay); FederationService.handleCallFrame.
 * - GET  /s2s/v1/state-feed — compacted profile/relationship/group state for the signed peer.
 * - POST /s2s/v1/feed-heads — an ephemeral merged state-feed / profile-namespace-feed wake-up hint.
 * - GET  /s2s/v1/profile-namespace-feed — the shared compacted identity-binding change feed.
 * - GET  /s2s/v1/profile-namespaces/:nsid — current bindings of one namespace id in this server's space.
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
    private readonly tombstoneFeed: FederationMessageTombstoneFeedService,
    private readonly settings: SettingsService,
    private readonly peerStateFeed: PeerStateFeedService,
    private readonly profileNamespaceFeed: ProfileNamespaceFeedService,
    private readonly profileNamespacePull: FederationProfileNamespacePullService,
    private readonly roundScheduler: FederationThreadRoundSchedulerService,
    private readonly groupMeta: FederationGroupMetaFeedService,
    private readonly keypair: KeypairService,
  ) {}

  @Get('group-meta')
  async getGroupMeta(
    @Req() req: FastifyRequest,
    @Query('account') account?: string,
    @Query('mode') mode?: string,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
    @Query('through') throughParam?: string,
  ) {
    this.assertQueryShape(req, ['account', 'mode', 'after', 'take', 'through']);
    if (typeof account !== 'string' || (mode !== 'full' && mode !== 'delta'))
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'group-meta requires a group account and mode full or delta',
        HttpStatus.BAD_REQUEST,
      );
    const normalizedAccount = requireAccount(account, 'account');
    if (!normalizedAccount.startsWith('!'))
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'group-meta account must be a group account',
        HttpStatus.BAD_REQUEST,
      );
    if (
      afterParam === undefined &&
      (takeParam !== undefined || throughParam !== undefined)
    )
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'group-meta take and through require after',
        HttpStatus.BAD_REQUEST,
      );
    const after =
      afterParam === undefined
        ? undefined
        : this.parseCursorSafeInteger(afterParam, 'after');
    const take =
      takeParam === undefined
        ? undefined
        : this.parsePositiveSafeIntegerQuery(takeParam, 'take');
    const through =
      throughParam === undefined
        ? undefined
        : this.parseCursorSafeInteger(throughParam, 'through');
    return this.groupMeta.serve(
      this.signerDomain(req),
      req.peer!.namespaceId,
      normalizedAccount,
      mode,
      after,
      take,
      through,
    );
  }

  /** Receive an ephemeral merged feed-head hint; actual data remains pull-only. */
  @Post('feed-heads')
  @HttpCode(HttpStatus.OK)
  async postDiscoveryHwm(@Req() req: FastifyRequest): Promise<void> {
    const signer = this.signerDomain(req);
    const body = req.body as {
      stateFeedEndId?: unknown;
      profileNamespaceFeedEndId?: unknown;
    } | null;
    const decimal = (value: unknown): value is string =>
      typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !decimal(body.stateFeedEndId) ||
      !decimal(body.profileNamespaceFeedEndId)
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'feed end IDs must be unsigned decimal strings',
        HttpStatus.BAD_REQUEST,
      );
    }
    const stateFeedEndId = BigInt(body.stateFeedEndId);
    this.roundScheduler.wakeStateFeed(signer, stateFeedEndId);
    // Each field is handled independently: the profile-namespace head wakes
    // that pull when it is ahead of the receiver's cursor.
    this.profileNamespacePull.wake(signer, BigInt(body.profileNamespaceFeedEndId));
  }

  /** The shared compacted identity-binding change feed. An omitted `after`
   *  is the first-pull form: the sender-side zero fallback serves every
   *  current item from 0. */
  @Get('profile-namespace-feed')
  async getProfileNamespaceFeed(
    @Req() req: FastifyRequest,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
    @Query('through') throughParam?: string,
  ) {
    this.assertQueryShape(req, ['after', 'take', 'through']);
    if (
      afterParam === undefined &&
      (takeParam !== undefined || throughParam !== undefined)
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'take and through require after',
        HttpStatus.BAD_REQUEST,
      );
    }
    const after =
      afterParam === undefined
        ? undefined
        : this.parseCursorBigInt(afterParam, 'after');
    const take =
      takeParam === undefined ? undefined : Number(takeParam);
    const through =
      throughParam === undefined
        ? undefined
        : this.parseCursorBigInt(throughParam, 'through');
    return this.profileNamespaceFeed.serve(after, take, through);
  }

  /** Current bindings of one namespace id in this responder's own namespace
   *  space. Id 0 is the responder itself; display/vouching data only. */
  @Get('profile-namespaces/:nsid')
  async getProfileNamespace(@Req() req: FastifyRequest): Promise<unknown> {
    const raw = (req.params as { nsid?: unknown }).nsid;
    if (
      typeof raw !== 'string' ||
      !/^(0|[1-9][0-9]{0,15})$/.test(raw)
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'nsid must be a non-negative decimal path parameter',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.profileNamespaceFeed.resolveBindings(Number(raw));
  }

  @Get('message-tombstones')
  async queryMessageTombstones(
    @Req() req: FastifyRequest,
    @Query('account') account?: string,
    @Query('peerAccount') peerAccount?: string,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
    @Query('through') throughParam?: string,
    @Query('includeSelf') includeSelfParam?: string,
    @Query('maxMessageSeq') maxMessageSeqParam?: string,
  ) {
    this.assertQueryShape(req, [
      'account',
      'peerAccount',
      'after',
      'take',
      'through',
      'includeSelf',
      'maxMessageSeq',
    ]);
    const selector = this.parseThreadQuery(account, peerAccount);
    const peerDomain = this.signerDomain(req);
    if (
      includeSelfParam !== undefined &&
      includeSelfParam !== 'true' &&
      includeSelfParam !== 'false'
    )
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'includeSelf must be true or false',
        HttpStatus.BAD_REQUEST,
      );
    const includeSelf = includeSelfParam !== 'false';
    if (afterParam === undefined) {
      if (
        takeParam !== undefined ||
        throughParam !== undefined ||
        maxMessageSeqParam !== undefined
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'page parameters require after',
          HttpStatus.BAD_REQUEST,
        );
      }
      return this.tombstoneFeed.rejectMissingQueryAfter(
        peerDomain,
        req.peer!.namespaceId,
        selector,
      );
    }
    const after = this.parseThreadSequence(afterParam, 'after');
    const take =
      takeParam === undefined
        ? undefined
        : this.parsePositiveSafeIntegerQuery(takeParam, 'take');
    const through =
      throughParam === undefined
        ? undefined
        : this.parseThreadSequence(throughParam, 'through');
    if (maxMessageSeqParam !== undefined && through === undefined) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'maxMessageSeq requires through',
        HttpStatus.BAD_REQUEST,
      );
    }
    const maxMessageSeq =
      maxMessageSeqParam === undefined
        ? undefined
        : this.parseThreadSequence(maxMessageSeqParam, 'maxMessageSeq');
    if (maxMessageSeq === Number.MAX_SAFE_INTEGER) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'maxMessageSeq must not exceed the maximum message sequence',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.tombstoneFeed.query(
      peerDomain,
      req.peer!.namespaceId,
      selector,
      after,
      take,
      through,
      includeSelf,
      maxMessageSeq,
    );
  }

  @Get('messages')
  async queryMessages(
    @Req() req: FastifyRequest,
    @Query('account') account?: string,
    @Query('peerAccount') peerAccount?: string,
    @Query('after') afterParam?: string,
    @Query('before') beforeParam?: string,
    @Query('take') takeParam?: string,
    @Query('through') throughParam?: string,
    @Query('includeSelf') includeSelfParam?: string,
  ) {
    this.assertQueryShape(req, [
      'account',
      'peerAccount',
      'after',
      'before',
      'take',
      'through',
      'includeSelf',
    ]);
    const selector = this.parseThreadQuery(account, peerAccount);
    const peerDomain = this.signerDomain(req);
    if (
      includeSelfParam !== undefined &&
      includeSelfParam !== 'true' &&
      includeSelfParam !== 'false'
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'includeSelf must be true or false',
        HttpStatus.BAD_REQUEST,
      );
    }
    const includeSelf = includeSelfParam !== 'false';
    if (afterParam !== undefined && beforeParam !== undefined) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'after and before are mutually exclusive',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (afterParam === undefined && beforeParam === undefined) {
      if (takeParam !== undefined || throughParam !== undefined) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'take and through require after or before',
          HttpStatus.BAD_REQUEST,
        );
      }
      return this.messageFeed.rejectMissingQueryAfter(
        peerDomain,
        req.peer!.namespaceId,
        selector,
      );
    }
    const after =
      afterParam === undefined
        ? undefined
        : this.parseThreadSequence(afterParam, 'after');
    const before =
      beforeParam === undefined
        ? undefined
        : this.parseThreadSequence(beforeParam, 'before', true);
    const take =
      takeParam === undefined
        ? undefined
        : this.parsePositiveSafeIntegerQuery(takeParam, 'take');
    const through =
      throughParam === undefined
        ? undefined
        : this.parseThreadSequence(throughParam, 'through');
    return this.messageFeed.query(
      peerDomain,
      req.peer!.namespaceId,
      selector,
      after,
      take,
      through,
      includeSelf,
      before,
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
    const namespaceId = req.peer!.namespaceId;
    if (afterParam === undefined) {
      if (takeParam !== undefined || throughParam !== undefined) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'take and through require after',
          HttpStatus.BAD_REQUEST,
        );
      }
      return this.peerStateFeed.rejectMissingAfter(namespaceId);
    }
    const after = this.parseCursorBigInt(afterParam, 'after');
    const take = takeParam === undefined ? undefined : Number(takeParam);
    const through =
      throughParam === undefined
        ? undefined
        : this.parseCursorBigInt(throughParam, 'through');
    return this.peerStateFeed.serve(
      namespaceId,
      after,
      take,
      through,
    );
  }

  @Post('call')
  @HttpCode(HttpStatus.OK)
  async postCall(@Req() req: FastifyRequest): Promise<null> {
    // handleCallFrame is awaitable + emits the frame to CallsService via emitAsync before returning,
    // so the 200 serializes behind the callee-side mirror setup (the caller's first `offer` cannot
    // win the race against the mirror it addresses).
    await this.federation.handleCallFrame(
      req.body,
      this.signerDomain(req),
      req.peer!.namespaceId,
      req.peer!.signatureExpiresAtSec,
    );
    return null;
  }

  @Get('accounts/:account')
  async getAccountProfile(@Req() req: FastifyRequest) {
    const parsed = parseFederationResourceRequest(req, {
      pathPrefix: '/s2s/v1/accounts/',
      pathName: 'account',
      query: [
        { name: 'publicKey' },
        { name: 'challenge' },
      ],
    });
    const account = requireAccount(parsed.pathValue, 'account');
    // The public current-profile lookup doubles as a possession proof: the
    // card is bound to the holder of the named key's private counterpart
    // because `proof` is the plaintext recovered from the caller's sealed
    // challenge. The plaintext is opaque to this server.
    const proof = this.keypair.openCardChallenge(
      parsed.query.publicKey,
      parsed.query.challenge,
    );
    // The endpoint serves OUR users and groups only. The account is the sole path segment;
    // profile identity uses the publisher-local subject marker.
    const address: S2SAddress = { account, domain: 'local' };
    const profile = await this.resourceOperation(() =>
      this.federation.getLocalAccountProfile(address),
    );
    if (!profile) {
      // HTTP 200 + code NOT_FOUND (a missing lookup target is a business outcome, not a protocol 404);
      // the global AllExceptionsFilter renders the envelope. The peer's getSigned detects the non-zero code.
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `account ${account} not found`,
      );
    }
    const { account: owner, displayName, bio, avatar, profileRev } = profile;
    return {
      account: owner,
      displayName,
      bio,
      avatar,
      profileRev,
      proof,
    };
  }

  @Get('intent-profiles/:namespaceId/:account/:peerAccount/:profileRev')
  async getIntentProfile(@Req() req: FastifyRequest) {
    const path = parseFederationResourcePath(req, '/s2s/v1/intent-profiles/', [
      'namespaceId',
      'account',
      'peerAccount',
      'profileRev',
    ]);
    const profileNamespaceId = requireSafeDecimal(
      path.namespaceId,
      'namespaceId',
    );
    const account = requireAccount(path.account, 'account');
    const peerAccount = requireAccount(path.peerAccount, 'peerAccount');
    const rev = requireSafeDecimal(path.profileRev, 'profileRev');
    if (rev < 1) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'profileRev must be positive',
        HttpStatus.BAD_REQUEST,
      );
    }
    const profile = await this.resourceOperation(() =>
      this.federation.getAuthorizedIntentProfile(
        account,
        peerAccount,
        profileNamespaceId,
        rev,
        this.signerDomain(req),
        req.peer!.namespaceId,
      ),
    );
    if (!profile) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'profile not found');
    }
    const {
      account: owner,
      displayName,
      bio,
      avatar,
    } = profile;
    return { account: owner, displayName, bio, avatar };
  }

  @Get('account-profiles/:namespaceId/:account/:profileRev')
  async getExactAccountProfile(@Req() req: FastifyRequest) {
    const path = parseFederationResourcePath(req, '/s2s/v1/account-profiles/', [
      'namespaceId',
      'account',
      'profileRev',
    ]);
    const profileNamespaceId = requireSafeDecimal(
      path.namespaceId,
      'namespaceId',
    );
    const account = requireAccount(path.account, 'account');
    const rev = requireSafeDecimal(path.profileRev, 'profileRev');
    if (rev < 1)
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'profileRev must be positive',
        HttpStatus.BAD_REQUEST,
      );
    const profile = await this.resourceOperation(() =>
      this.federation.getAuthorizedAccountProfile(
        account,
        profileNamespaceId,
        rev,
        this.signerDomain(req),
        req.peer!.namespaceId,
      ),
    );
    if (!profile)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'profile not found');
    const {
      account: owner,
      displayName,
      bio,
      avatar,
    } = profile;
    return { account: owner, displayName, bio, avatar };
  }

  @Get(
    'group-member-profiles/:groupAccount/:namespaceId/:memberAccount/:profileRev',
  )
  async getGroupMemberProfile(@Req() req: FastifyRequest) {
    const path = parseFederationResourcePath(
      req,
      '/s2s/v1/group-member-profiles/',
      ['groupAccount', 'namespaceId', 'memberAccount', 'profileRev'],
    );
    const groupAccount = requireAccount(path.groupAccount, 'groupAccount');
    if (!groupAccount.startsWith('!')) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'groupAccount must be a GroupAccount',
        HttpStatus.BAD_REQUEST,
      );
    }
    const profileNamespaceId = requireSafeDecimal(
      path.namespaceId,
      'namespaceId',
    );
    const memberAccount = requireUserAccount(
      path.memberAccount,
      'memberAccount',
    );
    const rev = requireSafeDecimal(path.profileRev, 'profileRev');
    if (rev < 1) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'profileRev must be positive',
        HttpStatus.BAD_REQUEST,
      );
    }
    const profile = await this.resourceOperation(() =>
      this.federation.getAuthorizedGroupMemberProfile(
        groupAccount,
        memberAccount,
        profileNamespaceId,
        rev,
        this.signerDomain(req),
        req.peer!.namespaceId,
      ),
    );
    if (!profile)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'profile not found');
    const { account, displayName, bio, avatar } = profile;
    return { account, displayName, bio, avatar };
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

  private parseCursorSafeInteger(
    value: string | undefined,
    name: string,
  ): number {
    if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `${name} must be a canonical non-negative decimal integer`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `${name} must be a non-negative safe integer`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return parsed;
  }

  private parseCursorBigInt(value: string | undefined, name: string): bigint {
    if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `${name} must be a canonical non-negative decimal integer`,
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

  private parseThreadSequence(
    value: string,
    name: string,
    allowUpperSentinel = false,
  ): number {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `${name} must be a canonical non-negative integer`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const parsed = Number(value);
    const maximum = allowUpperSentinel
      ? FEDERATION_THREAD_SEQUENCE_MAX + 1
      : FEDERATION_THREAD_SEQUENCE_MAX;
    if (!Number.isSafeInteger(parsed) || parsed > maximum) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        `${name} must be an integer between 0 and ${maximum}`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return parsed;
  }

  private parseThreadQuery(account?: string, peerAccount?: string) {
    if (account === undefined) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'account is required for a thread query',
        HttpStatus.BAD_REQUEST,
      );
    }
    const normalizedAccount = requireAccount(account, 'account');
    if (!normalizedAccount.startsWith('!')) {
      if (peerAccount === undefined) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'peerAccount is required for a P2P thread query',
          HttpStatus.BAD_REQUEST,
        );
      }
      return {
        type: 'P2P' as const,
        account: requireUserAccount(normalizedAccount, 'account'),
        peerAccount: requireUserAccount(peerAccount, 'peerAccount'),
      };
    }
    if (peerAccount !== undefined) {
      throw new BusinessException(
        BusinessCode.FEDERATION_MALFORMED,
        'peerAccount is forbidden for a GROUP thread query',
        HttpStatus.BAD_REQUEST,
      );
    }
    return { type: 'GROUP' as const, account: normalizedAccount };
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
    const signer = this.signerDomain(req);
    const { absPath, bytes } = await this.resourceOperation(() =>
      this.federation.resolveMediaFile(
        fromAccount,
        toAccount,
        fromDomain,
        signer,
        req.peer!.namespaceId,
        digest,
        seq,
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
        req.peer!.namespaceId,
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
