import { describeError } from '../logger/describe-error.js';
import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Sse,
  type MessageEvent,
  Request,
  HttpStatus,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { FederationDomainResolutionError } from '../federation/discovery.service.js';
import { UserService } from '../user/user.service.js';
import { UploadService } from '../upload/upload.service.js';
import { MessageService } from '../message/message.service.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { AuthService } from '../auth/auth.service.js';
import { SseService } from '../gateway/sse.service.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { ClientGroupMetaFeedService } from '../client-state-feed/client-group-meta-feed.service.js';
import { Public } from '../common/public.decorator.js';
import { ApiResultResponse, envelope } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { PUBLIC_CONFIG } from '../config/public-config.js';
import { normalizeAccount } from '../common/account.js';
import { UserResponseDto } from '../dto/response.dto.js';
import { RegisterDto } from '../dto/auth.dto.js';
import {
  UserResolveDto,
  UserSearchDto,
  UpdateProfileDto,
} from '../dto/user.dto.js';
import { S2sResponseError } from '../federation/federation-errors.js';
import type { S2SProfile } from '../federation/federation-profile.js';
import type { PossessionKey } from '../federation/federation-profile.service.js';
import { FederationProfileService } from '../federation/federation-profile.service.js';
import { FederationPeerLifecycle } from '../federation/federation-peer-lifecycle.js';
import { KeypairService } from '../federation/keypair.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { RelationshipService } from '../relationship/relationship.service.js';
import { Raw } from '../common/raw.decorator.js';
import { STATE_FEED_PAGE_MAX_BYTES } from '../common/feed-page.js';
import { serializeBody } from '../common/serialize.interceptor.js';
import { FederationRecognitionService } from '../federation/federation-recognition.service.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import { GroupService } from '../group/group.service.js';
import { ProfileNamespaceFeedService } from '../federation/profile-namespace-feed.service.js';
import { parseGroupMetaFeedDemand } from '../../shared/group-meta-demand.js';

/** One item in the device-facing compacted state feed. */
type ClientStateFeedItem = {
  feedId: number;
  body: unknown;
};

function nextUtcMidnight(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}

@ApiTags('user')
@Controller()
export class UserController {
  private readonly logger = new Logger(UserController.name);

  constructor(
    private readonly userService: UserService,
    private readonly participantService: AccountThreadStateService,
    private readonly authService: AuthService,
    private readonly uploadService: UploadService,
    private readonly sseService: SseService,
    private readonly messageService: MessageService,
    private readonly keypairs: KeypairService,
    private readonly peerLifecycle: FederationPeerLifecycle,
    private readonly profiles: FederationProfileService,
    private readonly federationRecognition: FederationRecognitionService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly clientGroupMetaFeed: ClientGroupMetaFeedService,
    private readonly profileNamespaceFeed: ProfileNamespaceFeedService,
    private readonly userQuotaService: UserQuotaService,
    private readonly relationships: RelationshipService,
    private readonly durableTasks: DurableTaskQueueService,
    private readonly groups: GroupService,
  ) {}

  private async resolveLocalAccount(account: string) {
    if (account.startsWith('!')) {
      const group = await this.groups.findPublicLocalGroupByAccount(account);
      if (!group) return null;
      return {
        id: group.id,
        account: group.account,
        name: group.name,
        avatar: group.avatar,
        bio: group.description,
        isGroup: true,
        namespaceId: 0,
        profileRev: group.profileRev,
        isDeleted: false,
      };
    }
    return this.userService.findUniqueUser({
      account,
      availability: 'AVAILABLE',
    });
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/my-profile')
  @ApiOperation({ summary: 'Get the current user profile' })
  @ApiResultResponse(UserResponseDto)
  async getMyProfile(@Request() req: FastifyRequest) {
    // findSelfProfile omits hashPwd. Friend-request notification state travels in the unified state delta;
    // its seen cursor is local to each device.
    const profile = await this.userService.findSelfProfile(req.user.userId);
    if (!profile) return profile;
    const { defaultProfileRev, ...rest } = profile;
    return { ...rest, profileRev: defaultProfileRev };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/my-quota')
  @ApiOperation({
    summary:
      "View the current local account's effective quota and today's usage",
  })
  async getMyQuota(@Request() req: FastifyRequest) {
    const state = await this.userQuotaService.getState(req.user.userId);
    return {
      usage: state.usage,
      breaker: state.breaker,
      resetAt: nextUtcMidnight().getTime(),
    };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/update-profile')
  @ApiOperation({
    summary:
      'Update the current user display name / bio (account is immutable)',
  })
  @ApiResultResponse(UserResponseDto)
  async updateProfile(
    @Request() req: FastifyRequest,
    @Body() dto: UpdateProfileDto,
  ) {
    let avatar: string | null | undefined;
    if (dto.avatarBase64 === null) avatar = null;
    else if (dto.avatarBase64 !== undefined) {
      try {
        avatar = await this.uploadService.saveAvatarFromClientBase64(
          dto.avatarBase64,
        );
      } catch {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'invalid avatar',
        );
      }
    }
    return this.userService.updateProfile(req.user.userId, {
      name: dto.name,
      bio: dto.bio,
      avatar,
    });
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Get('user/profile-namespace-feed')
  @ApiOperation({
    summary:
      'Fetch compacted profile-namespace binding changes for this device',
  })
  async queryProfileNamespaceFeed(
    @Request() req: FastifyRequest,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
  ) {
    const parse = (value: string, name: string): number => {
      if (!/^(0|[1-9]\d*)$/.test(value))
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          `${name} must be a non-negative integer`,
          HttpStatus.BAD_REQUEST,
        );
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed))
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          `${name} exceeds the safe integer range`,
          HttpStatus.BAD_REQUEST,
        );
      return parsed;
    };
    const after =
      afterParam === undefined ? undefined : parse(afterParam, 'after');
    const take = takeParam === undefined ? undefined : parse(takeParam, 'take');
    return this.profileNamespaceFeed.serveClientChanges(after, take);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Get('user/state-feed')
  @ApiOperation({
    summary: 'Fetch compacted client state in a fixed feed-id range',
  })
  async queryStateFeed(
    @Request() req: FastifyRequest,
    @Query('mode') modeParam?: string,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
    @Query('through') throughParam?: string,
  ) {
    const me = req.user.userId;
    const requestedMode = modeParam ?? 'delta';
    if (requestedMode !== 'full' && requestedMode !== 'delta')
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'mode must be full or delta',
        HttpStatus.BAD_REQUEST,
      );
    const mode: 'full' | 'delta' = requestedMode;
    if (afterParam === undefined) {
      return this.clientStateFeed.rejectMissingAfter(me);
    }
    const parseCursor = (value: string, name: string): number => {
      if (!/^(0|[1-9]\d*)$/.test(value))
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          `${name} must be a non-negative integer`,
          HttpStatus.BAD_REQUEST,
        );
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed))
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          `${name} exceeds the safe integer range`,
          HttpStatus.BAD_REQUEST,
        );
      return parsed;
    };
    const after = parseCursor(afterParam, 'after');
    const take = takeParam === undefined ? 100 : parseCursor(takeParam, 'take');
    if (take < 1 || take > 200)
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'take must be an integer from 1 to 200',
        HttpStatus.BAD_REQUEST,
      );
    const through =
      throughParam === undefined
        ? undefined
        : parseCursor(throughParam, 'through');
    if (through !== undefined && through < after)
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'through must be greater than or equal to after',
        HttpStatus.BAD_REQUEST,
      );
    const stateFeedEndId = await this.clientStateFeed.readEndId(me);
    const profileNamespaceChangeEndId = Number(
      await this.profileNamespaceFeed.clientChangeEnd(),
    );
    if (!Number.isSafeInteger(profileNamespaceChangeEndId))
      throw new Error(
        'profile namespace change head exceeds the client-safe integer range',
      );
    if (after > stateFeedEndId) {
      throw new BusinessException(
        BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
        'state feed cursor is outside the available coordinate space',
        HttpStatus.OK,
        { resumeAfter: 0, resumeBefore: stateFeedEndId + 1 },
      );
    }
    const scanEnd = Math.min(through ?? stateFeedEndId, stateFeedEndId);
    const candidates = (
      await this.clientStateFeed.query(me, mode, after, scanEnd)
    ).map((item) => ({
      feedId: item.feedId,
      body: item.body,
    })) satisfies ClientStateFeedItem[];
    candidates.sort((a, b) => a.feedId - b.feedId);
    const items: ClientStateFeedItem[] = [];
    let bytes = 0;
    for (const item of candidates.slice(0, take)) {
      const itemBytes = Buffer.byteLength(JSON.stringify(item));
      if (items.length > 0 && bytes + itemBytes > STATE_FEED_PAGE_MAX_BYTES)
        break;
      items.push(item);
      bytes += itemBytes;
    }
    const scannedThrough =
      items.length < candidates.length
        ? (items.at(-1)?.feedId ?? after)
        : scanEnd;
    return {
      mode,
      items,
      scannedThrough,
      stateFeedEndId,
      // Client change-feed head in every state-feed envelope: a device that
      // missed a PROFILE_NAMESPACE_UPDATED wake converges on its next
      // state-feed pull (the s2s envelope-observation pattern, mirrored).
      profileNamespaceChangeEndId,
      hasMore: scannedThrough < scanEnd,
    };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Get('user/group-meta')
  @ApiOperation({ summary: 'Fetch one client-visible group member feed' })
  async queryGroupMeta(
    @Request() req: FastifyRequest,
    @Query('threadId') threadIdParam?: string,
    @Query('account') accountParam?: string,
    @Query('namespaceId') namespaceIdParam?: string,
    @Query('mode') modeParam?: string,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
    @Query('through') throughParam?: string,
  ) {
    const parseCursor = (value: string, name: string): number => {
      if (!/^(0|[1-9]\d*)$/.test(value))
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          `${name} must be a non-negative integer`,
          HttpStatus.BAD_REQUEST,
        );
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed))
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          `${name} must be a non-negative safe integer`,
          HttpStatus.BAD_REQUEST,
        );
      return parsed;
    };
    const mode = modeParam ?? 'delta';
    if (mode !== 'full' && mode !== 'delta')
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'mode must be full or delta',
        HttpStatus.BAD_REQUEST,
      );
    if (afterParam === undefined)
      throw new BusinessException(
        BusinessCode.CLIENT_FEED_CURSOR_UNAVAILABLE,
        'after is required; initialize the group meta feed cursor',
        HttpStatus.OK,
        { resumeAfter: '0' },
      );
    // The closed shared demand parser rejects mixes and partial forms; the
    // controller never hand-validates the coordinate shape.
    let target: { groupId: number; account: string };
    try {
      const demand = parseGroupMetaFeedDemand({
        ...(threadIdParam !== undefined ? { threadId: threadIdParam } : {}),
        ...(accountParam !== undefined ? { account: accountParam } : {}),
        ...(namespaceIdParam !== undefined
          ? { namespaceId: namespaceIdParam }
          : {}),
      });
      target = await this.clientGroupMetaFeed.resolveVisibleGroup(
        req.user.userId,
        demand,
      );
    } catch (error) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        error instanceof Error
          ? error.message
          : 'invalid group meta feed demand',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.clientGroupMetaFeed.serve(
      req.user.userId,
      target.groupId,
      target.account,
      mode,
      parseCursor(afterParam, 'after'),
      takeParam === undefined ? 100 : Number(parseCursor(takeParam, 'take')),
      throughParam === undefined
        ? undefined
        : parseCursor(throughParam, 'through'),
    );
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/resolve')
  @ApiOperation({ summary: 'Resolve a local user or group by exact account' })
  @ApiResultResponse(UserResponseDto)
  async resolveUser(@Body() dto: UserResolveDto) {
    const account = normalizeAccount(dto.account);
    const { domain } = dto;
    const localDomain = this.keypairs.localAddress(account).domain;
    if (domain && domain.trim().toLowerCase() !== localDomain) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'federated lookup requires resolve-federated-stream',
      );
    }
    // No domain or the publisher's current domain means a local account lookup.
    const user = await this.resolveLocalAccount(account);
    if (user !== null) {
      return user;
    }
    throw new BusinessException(
      BusinessCode.NOT_FOUND,
      `can not find user [${account}]`,
    );
  }

  /** Temporary resolve stream. It has one terminal result and never materializes a User stub. The
   * browser may close it at any time; the peer request retains its normal bounded S2S timeout. */
  @Raw()
  @ApiBearerAuth()
  @Sse('user/resolve-federated-stream')
  resolveFederatedUserStream(
    @Query() dto: UserResolveDto,
  ): Observable<MessageEvent> {
    const account = normalizeAccount(dto.account);
    const domain = dto.domain?.trim().toLowerCase() ?? '';
    return new Observable<MessageEvent>((sink) => {
      let unsubscribeProgress: () => void = () => undefined;
      const emit = (type: string, data: unknown) => {
        if (!sink.closed)
          sink.next({ type, data: serializeBody(data) as object });
      };
      const finish = (type: string, data: unknown) => {
        if (sink.closed) return;
        emit(type, data);
        sink.complete();
      };
      const deadlineAt = Date.now() + 30_000;
      const deadline = setTimeout(
        () => finish('failed', { reason: 'TIMEOUT' }),
        30_000,
      );
      void (async () => {
        try {
          if (!domain) {
            finish('failed', { reason: 'INVALID_ADDRESS' });
            return;
          }
          if (domain === this.keypairs.localAddress(account).domain) {
            const localUser = await this.resolveLocalAccount(account);
            finish(
              localUser ? 'resolved' : 'failed',
              localUser ? { user: localUser } : { reason: 'NOT_FOUND' },
            );
            return;
          }
          const recognitionComplete =
            await this.peerLifecycle.hasCompleteRecognition(domain);
          if (sink.closed) return;
          if (!recognitionComplete) {
            unsubscribeProgress = this.federationRecognition.subscribeProgress(
              domain,
              (stage) => emit('progress', { stage }),
            );
            await this.federationRecognition.recognize(domain);
          }
          if (sink.closed) return;
          emit('progress', { stage: 'WAITING_FOR_PEER' });
          while (!sink.closed && Date.now() < deadlineAt) {
            try {
              const status = await this.peerLifecycle.checkHealth(domain);
              if (status === 'available' || status === 'degraded') {
                await this.peerLifecycle.checkOutboundReady(domain);
                break;
              }
            } catch (error) {
              if (
                error instanceof FederationDomainResolutionError ||
                (error instanceof BusinessException &&
                  error.bizCode !==
                    BusinessCode.FEDERATION_RECOGNITION_REQUIRED)
              ) {
                throw error;
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          if (sink.closed) return;
          if (Date.now() >= deadlineAt) {
            finish('failed', { reason: 'TIMEOUT' });
            return;
          }
          emit('progress', { stage: 'FETCHING_USER' });
          // Prior knowledge (a contact card or roster reference carries the
          // vouched lineage) resolves via VOUCH: the challenge is sealed
          // under the root key the publisher's profile-namespace bindings
          // name for the referenced identity, not under the local handshake
          // pin. First contact by address falls back to PIN.
          const hasVouch =
            typeof dto.publisherNamespaceId === 'number' ||
            typeof dto.profileNamespaceId === 'number' ||
            typeof dto.publicKey === 'string';
          const possession: PossessionKey = hasVouch
            ? typeof dto.publicKey === 'string' &&
              (dto.publisherNamespaceId === undefined) ===
                (dto.profileNamespaceId === undefined)
              ? typeof dto.publisherNamespaceId === 'number' &&
                typeof dto.profileNamespaceId === 'number'
                ? {
                    kind: 'VOUCH',
                    publisherNamespaceId: dto.publisherNamespaceId,
                    profileNamespaceId: dto.profileNamespaceId,
                    publicKey: dto.publicKey,
                  }
                : { kind: 'CARD', publicKey: dto.publicKey }
              : (() => {
                  throw new BusinessException(
                    BusinessCode.VALIDATION_FAILED,
                    'contact-card resolve requires publicKey and either both or neither namespace coordinates',
                  );
                })()
            : { kind: 'PIN' };
          const profile = await this.profiles.fetchRemoteAccount(
            { account, domain },
            possession,
          );
          // Recognition (stage one) already materialized the peer's identity
          // namespace row; the context read is the identity coordinate the
          // federated request DTOs carry — no domain on the transient card.
          const { namespaceId } =
            await this.federationRecognition.captureContext(domain);
          finish('resolved', {
            user: this.transientFederatedUser(profile, namespaceId),
          });
        } catch (error) {
          if (sink.closed) return;
          const reason =
            error instanceof FederationDomainResolutionError
              ? 'DOMAIN_RESOLUTION_FAILED'
              : error instanceof S2sResponseError &&
                  error.code === BusinessCode.NOT_FOUND
                ? 'NOT_FOUND'
                : error instanceof BusinessException &&
                    error.bizCode === BusinessCode.FEDERATION_PEER_BLOCKED
                  ? 'BLOCKED'
                  : error instanceof BusinessException &&
                      error.bizCode ===
                        BusinessCode.FEDERATION_PEER_IDENTITY_LOST
                    ? 'IDENTITY_LOST'
                    : 'UNREACHABLE';
          if (
            reason !== 'NOT_FOUND' &&
            reason !== 'BLOCKED' &&
            reason !== 'IDENTITY_LOST'
          ) {
            this.logger.warn({
              msg: `Federated user resolution failed (${reason})`,
              account,
              peerDomain: domain,
              reason,
              error: describeError(error),
            });
          }
          finish('failed', { reason });
        }
      })();
      return () => {
        clearTimeout(deadline);
        unsubscribeProgress();
      };
    });
  }

  /** Transient resolve card. Identity is the pure `(namespaceId, account)`
   *  coordinate — no domain field: clients address mutations by namespaceId
   *  and render display domains from their own namespace cache. */
  private transientFederatedUser(
    profile: S2SProfile,
    namespaceId: number,
  ): UserResponseDto {
    return {
      id: 0,
      account: profile.account,
      name: profile.displayName,
      avatar: profile.avatar
        ? `data:${profile.avatar.mimeType};base64,${profile.avatar.base64}`
        : '',
      bio: profile.bio,
      isGroup: profile.account.startsWith('!'),
      namespaceId,
      isDeleted: false,
      profileRev: 0,
    };
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/search')
  @ApiOperation({
    summary:
      'Fuzzy local identity discovery by account OR display name (local users and groups)',
  })
  async searchUsers(@Body() dto: UserSearchDto) {
    // Discovery endpoint — the two abuse guardrails are the DTO's @MinLength(2) on q and the hard
    // take cap here (a client must never page through the whole user table). Federated users are not
    // discoverable: resolve those by exact account + domain via /user/resolve. Only local,
    // non-deleted user and group accounts are returned.
    const take = Math.min(dto.take ?? 20, 20);
    return this.userService.searchUsers(dto.q.trim(), {
      skip: dto.skip ?? 0,
      take,
    });
  }

  @Public()
  @ApiTags('auth')
  @HttpCode(HttpStatus.OK)
  @Post('user/register')
  @ApiOperation({ summary: 'Register a new user' })
  async registerLocal(@Body() dto: RegisterDto) {
    // Self-registration gate: when the site is in admin-provisioned mode (registrationOpen=false) the
    // register endpoint refuses up front — accounts come from POST admin/users/create instead. The
    // registration logic below is untouched; only this switch is added.
    if (!PUBLIC_CONFIG.registrationOpen) {
      throw new BusinessException(
        BusinessCode.REGISTRATION_DISABLED,
        'registration is closed',
      );
    }
    /* Format validation (regex) for account/password has moved into RegisterDto's @Matches → failures
       go through ValidationPipe → 200/10000. Business validation (account duplicate) stays in the
       service → 200 + ALREADY_EXISTS. */
    const res = await this.userService.addUser({
      account: dto.account,
      name: dto.name,
      hashPwd: await this.authService.hashPassword(dto.password),
    });
    if (res.status === 2) {
      throw new BusinessException(
        BusinessCode.ALREADY_EXISTS,
        `User ${dto.account} already exists`,
      );
    }
    return envelope(res.data, { message: 'successfuly registered' });
  }
}
