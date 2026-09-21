import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  Request,
  HttpStatus,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { FastifyReply } from 'fastify';
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
  QueryUsersDto,
  UpdateProfileDto,
} from '../dto/user.dto.js';
import {
  FederationService,
  S2sResponseError,
  type S2SProfile,
} from '../federation/federation.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { RelationshipService } from '../relationship/relationship.service.js';
import { Raw } from '../common/raw.decorator.js';
import { STATE_FEED_PAGE_MAX_BYTES } from '../common/feed-page.js';
import { formatSseFrame, initSseResponse } from '../common/sse-stream.js';
import { FederationRecognitionService } from '../federation/federation-recognition.service.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';

/** One item in the device-facing compacted state feed. */
type ClientStateFeedItem = {
  feedId: number;
  account: string;
  domain: string;
  namespaceId: number;
  eventType: 'RELATIONSHIP_INTENT' | 'INCOMING_INVITE_HEAD' | 'THREAD_STATE';
  subjectAccount: string;
  subjectDomain: string;
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
    private readonly federationService: FederationService,
    private readonly federationRecognition: FederationRecognitionService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly clientGroupMetaFeed: ClientGroupMetaFeedService,
    private readonly userQuotaService: UserQuotaService,
    private readonly relationships: RelationshipService,
    private readonly durableTasks: DurableTaskQueueService,
  ) {}

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
      account: item.account,
      domain: item.domain,
      namespaceId: item.namespaceId,
      eventType: item.eventType as ClientStateFeedItem['eventType'],
      subjectAccount: item.subjectAccount,
      subjectDomain: item.subjectDomain,
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
    @Query('domain') domainParam?: string,
    @Query('mode') modeParam?: string,
    @Query('after') afterParam?: string,
    @Query('take') takeParam?: string,
    @Query('through') throughParam?: string,
  ) {
    if ((threadIdParam === undefined) === (accountParam === undefined))
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'exactly one of threadId or account is required',
        HttpStatus.BAD_REQUEST,
      );
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
    const threadId =
      threadIdParam === undefined
        ? undefined
        : Number(parseCursor(threadIdParam, 'threadId'));
    if (
      threadId !== undefined &&
      (!Number.isSafeInteger(threadId) || threadId < 1)
    )
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'threadId must be a positive safe integer',
        HttpStatus.BAD_REQUEST,
      );
    const target = await this.clientGroupMetaFeed.resolveVisibleGroup(
      req.user.userId,
      {
        threadId,
        account: accountParam,
        domain: domainParam,
      },
    );
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
  @Post('user/query')
  @ApiOperation({
    summary: 'Look up users by account and domain in batch (≤100)',
  })
  @ApiResultResponse(UserResponseDto, true)
  async queryUserBase(@Body() dto: QueryUsersDto) {
    return this.userService.queryUsers({
      where: { addresses: dto.addresses, availability: 'AVAILABLE' },
    });
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('user/resolve')
  @ApiOperation({
    summary: 'Resolve a local user by account',
  })
  @ApiResultResponse(UserResponseDto)
  async resolveUser(@Body() dto: UserResolveDto) {
    const account = normalizeAccount(dto.account);
    const { domain } = dto;
    if (domain && domain !== this.federationService.ourDomain) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'federated lookup requires resolve-federated-stream',
      );
    }
    // No domain, or our own domain, is a local account lookup.
    const user = await this.userService.findUniqueUser({
      account_domain: { account: account, domain: 'local' },
      namespaceId: 0,
      availability: 'AVAILABLE',
    });
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
  @Get('user/resolve-federated-stream')
  async resolveFederatedUserStream(
    @Request() req: FastifyRequest,
    @Query() dto: UserResolveDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    reply.hijack();
    const heartbeat = initSseResponse(reply.raw, req.headers.origin);
    let closed = false;
    const finish = (event: string, data: unknown) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      reply.raw.write(formatSseFrame(event, data));
      reply.raw.end();
    };
    reply.raw.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
    });
    const account = normalizeAccount(dto.account);
    const domain = dto.domain?.trim().toLowerCase() ?? '';
    if (!domain) {
      finish('failed', { reason: 'INVALID_ADDRESS' });
      return;
    }
    if (domain === this.federationService.ourDomain) {
      const localUser = await this.userService.findUniqueUser({
        account_domain: { account, domain: 'local' },
        namespaceId: 0,
        availability: 'AVAILABLE',
      });
      if (!localUser) {
        finish('failed', { reason: 'NOT_FOUND' });
        return;
      }
      const [relationship] =
        await this.relationships.friendRelationshipStatuses(req.user.userId, [
          localUser.id,
        ]);
      finish('resolved', {
        user: localUser,
        relationship: relationship?.status ?? 'NONE',
      });
      return;
    }
    let unsubscribeProgress: () => void = () => undefined;
    const deadlineAt = Date.now() + 30_000;
    const deadline = new Promise<never>((_, reject) => {
      const handle = setTimeout(
        () => reject(new Error('resolve deadline exceeded')),
        30_000,
      );
      reply.raw.once('close', () => clearTimeout(handle));
    });
    try {
      const profile = await Promise.race([
        (async () => {
          const recognitionComplete =
            await this.federationService.hasCompletePeerRecognition(domain);
          if (!recognitionComplete) {
            unsubscribeProgress = this.federationRecognition.subscribeProgress(
              domain,
              (stage) => {
                if (!closed) {
                  reply.raw.write(formatSseFrame('progress', { stage }));
                }
              },
            );
            await this.federationRecognition.recognize(domain);
          }
          if (!closed) {
            reply.raw.write(
              formatSseFrame('progress', { stage: 'WAITING_FOR_PEER' }),
            );
          }
          while (!closed && Date.now() < deadlineAt) {
            try {
              const status =
                await this.federationService.checkPeerHealth(domain);
              if (status === 'available' || status === 'degraded') {
                await this.federationService.checkPeerOutboundReady(domain);
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
          if (closed) throw new Error('resolve stream closed');
          if (Date.now() >= deadlineAt) {
            throw new Error('resolve deadline exceeded');
          }
          if (!closed) {
            reply.raw.write(
              formatSseFrame('progress', { stage: 'FETCHING_USER' }),
            );
          }
          return this.federationService.fetchRemoteAccount({ account, domain });
        })(),
        deadline,
      ]);
      const relationship = profile.account.startsWith('!')
        ? 'NONE'
        : await this.relationships.federatedRelationshipStatus(
            req.user.userId,
            account,
            domain,
          );
      finish('resolved', {
        user: this.transientFederatedUser(profile),
        relationship,
      });
    } catch (error) {
      if (closed) return;
      const reason =
        (error as Error).message === 'resolve deadline exceeded'
          ? 'TIMEOUT'
          : error instanceof FederationDomainResolutionError
            ? 'DOMAIN_RESOLUTION_FAILED'
            : error instanceof S2sResponseError &&
                error.code === BusinessCode.NOT_FOUND
              ? 'NOT_FOUND'
              : error instanceof BusinessException &&
                  error.bizCode === BusinessCode.FEDERATION_PEER_BLOCKED
                ? 'BLOCKED'
                : 'UNREACHABLE';
      if (reason !== 'NOT_FOUND' && reason !== 'BLOCKED') {
        const detail = error instanceof Error ? error.stack : String(error);
        this.logger.warn(
          `Federated resolve ${account}@${domain} failed (${reason}): ${detail}`,
        );
      }
      finish('failed', {
        reason,
      });
    } finally {
      unsubscribeProgress();
    }
  }

  private transientFederatedUser(profile: S2SProfile) {
    const now = Date.now();
    return {
      id: 0,
      account: profile.account,
      name: profile.displayName,
      avatar: profile.avatar
        ? `data:${profile.avatar.mimeType};base64,${profile.avatar.base64}`
        : '',
      bio: profile.bio,
      isGroup: profile.account.startsWith('!'),
      domain: profile.domain,
      createdAt: now,
      updatedAt: now,
      isDeleted: false,
      profileRev: 0,
      remoteProfileRev: profile.profileRev,
      mustChangePassword: false,
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
