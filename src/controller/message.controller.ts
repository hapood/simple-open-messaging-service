import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { MessageService } from '../message/message.service.js';
import { ContactCardProfileService } from '../message/contact-card/contact-card-profile.service.js';
import { assertContactCardTargetVisible } from '../message/contact-card/contact-card-target.js';
import { ContentType, GroupRole } from '../database/enums.js';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import {
  ApiResultResponse,
  businessEnvelope,
  envelope,
} from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  MessageQueryPageDto,
  MessageResponseDto,
  MessageTombstoneQueryPageDto,
  ThreadFeedPageDto,
  ThreadAliasResultDto,
  ThreadReadPositionResultDto,
} from '../dto/response.dto.js';
import { UserService } from '../user/user.service.js';
import { GroupService } from '../group/group.service.js';
import { ThreadFeedService } from '../message/thread-feed.service.js';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { ThreadAccessGuard } from '../account-thread-state/thread-access.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import { Raw } from '../common/raw.decorator.js';
import { parseLinkContent } from '../upload/file-content.js';
import { FederationService } from '../federation/federation.service.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import {
  SendMessageDto,
  SendMediaDto,
  AbandonMediaStageDto,
  QueryMediaStagesDto,
  QueryMessagesDto,
  MarkReadDto,
  ThreadFeedQueryDto,
  MediaStatusDto,
  MediaFileProgressDto,
  MediaMessageProgressDto,
  RelocalizeMediaDto,
  SetMutedDto,
  SetBlockedDto,
  SetPinnedDto,
  SetAliasDto,
  SearchMessagesDto,
  SendForwardDto,
  ForwardMode,
  QueryDeletedMessagesDto,
  WithdrawMessageDto,
  SendContactCardDto,
} from '../dto/message.dto.js';
import {
  serializeAudienceMention,
  serializeUserMention,
  transformMessageEntities,
} from '../common/message-entity.js';
import { ForwardBundleService } from '../forward/forward-bundle.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { SseService } from '../gateway/sse.service.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import { MessageReportService } from '../message/message-report.service.js';
import { CreateMessageReportDto } from '../message/message-report.dto.js';
import { ThreadReadPositionService } from '../message/thread-read-position.service.js';
import { isBusinessRejection } from '../common/business-command-result.js';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
  TEXT_MESSAGE_MAX_CODE_POINTS,
  unicodeCodePointLength,
  hasUnpairedSurrogate,
} from '../../shared/text-message-content.js';

@ApiTags('message')
@Controller()
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly attention: ThreadFeedService,
    private readonly participantService: AccountThreadStateService,
    private readonly federation: FederationService,
    private readonly linkPreview: LinkPreviewService,
    private readonly forwardBundles: ForwardBundleService,
    private readonly userQuota: UserQuotaService,
    private readonly deletedMessages: DeletedMessageService,
    private readonly messageReports: MessageReportService,
    private readonly users: UserService,
    private readonly groups: GroupService,
    private readonly contactProfiles: ContactCardProfileService,
    private readonly readPositions: ThreadReadPositionService,
    private readonly sse: SseService,
  ) {}

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<CreateMessageReportDto>('threadId')
  @Throttle('message.report')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('message-reports')
  @ApiOperation({ summary: 'Report one message in a conversation' })
  async reportMessage(
    @Request() req: FastifyRequest,
    @Body() dto: CreateMessageReportDto,
  ) {
    return this.messageReports.create(req.user.userId, dto);
  }

  @UseGuards(ThreadAccessGuard)
  @ResourceId<QueryDeletedMessagesDto>('threadId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('deleted-messages/query')
  @ApiOperation({
    summary: 'Query one conversation tombstone log by cursor',
  })
  @ApiResultResponse(MessageTombstoneQueryPageDto)
  async queryDeletedMessages(@Body() dto: QueryDeletedMessagesDto) {
    if ((dto.after === undefined) === (dto.before === undefined)) {
      if (dto.after !== undefined)
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'after and before are mutually exclusive',
          HttpStatus.BAD_REQUEST,
        );
      if (dto.through !== undefined || dto.take !== undefined)
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'take and through require after or before',
          HttpStatus.BAD_REQUEST,
        );
    }
    const after = dto.after;
    const before = dto.before;
    const through = dto.through;
    if (after !== undefined && through !== undefined && through < after)
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'through must be greater than or equal to after',
        HttpStatus.BAD_REQUEST,
      );
    if (before !== undefined && through !== undefined && through > before)
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'through must be less than or equal to before',
        HttpStatus.BAD_REQUEST,
      );
    return this.deletedMessages.queryThread(
      dto.threadId,
      after,
      dto.take ?? 100,
      through,
      before,
      dto.maxMessageSeq,
    );
  }

  @UseGuards(ThreadAccessGuard)
  @ResourceId<WithdrawMessageDto>('threadId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('withdraw-message')
  @ApiOperation({ summary: 'Withdraw a locally-authored message' })
  async withdrawMessage(
    @Request() req: FastifyRequest,
    @Body() dto: WithdrawMessageDto,
  ) {
    const deleted = await this.deletedMessages.withdraw(
      req.user.userId,
      dto.threadId,
      dto.seq,
      async (tx) => {
        await this.userQuota.assertCanSend(req.user.userId);
        await this.userQuota.tickLax(req.user.userId, 'messages', tx);
      },
    );
    return deleted;
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SendMessageDto>('threadId')
  @Throttle('message.send')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('send-message')
  @ApiOperation({ summary: 'Send a message (unified for P2P and group)' })
  @ApiResultResponse(MessageResponseDto)
  async sendMessage(
    @Request() req: FastifyRequest,
    @Body() dto: SendMessageDto,
  ) {
    let generationId: string | undefined;
    if (
      req.threadAccess.threadType === 'P2P' &&
      !req.threadAccess.friendshipActive
    ) {
      throw new BusinessException(BusinessCode.FRIEND_NOT_FOUND, 'not friends');
    }
    if (
      req.threadAccess.threadType === 'GROUP' &&
      !req.threadAccess.membershipActive
    ) {
      throw new BusinessException(BusinessCode.GROUP_FORBIDDEN, 'not a member');
    }
    if (req.threadAccess.groupDissolved) {
      throw new BusinessException(
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    }
    if (req.threadAccess.threadType === 'GROUP') {
      await this.federation.assertGroupWritable(dto.threadId);
    } else {
      await this.federation.assertP2PWritable(dto.threadId, req.user.userId);
    }
    // A successful LINK send deletes its short-lived generation immediately. Resolve an HTTP retry by
    // clientMessageId before looking up that generation, so a lost 200 response remains idempotent.
    if (dto.clientMessageId) {
      const prior = await this.messageService.findByClientMessageId(
        dto.clientMessageId,
      );
      if (prior) {
        if (
          !(await this.messageService.isAuthoredBy(
            prior.creator,
            req.user.userId,
          )) ||
          prior.threadId !== dto.threadId
        ) {
          throw new BusinessException(
            BusinessCode.VALIDATION_FAILED,
            'invalid clientMessageId',
          );
        }
        return prior;
      }
    }
    const contentType = dto.contentType ?? ContentType.PURE_TEXT;
    if (contentType === ContentType.PURE_TEXT) {
      // Keep the pre-envelope wire contract working: older clients send the text body directly.
      // JSON-looking input is still required to be a valid envelope so malformed quote payloads are
      // not silently converted into visible text. Persistence remains canonical JSON in both cases.
      const parsedTextContent = parseTextMessageContent(dto.content);
      const trimmedContent = dto.content.trimStart();
      const textContent =
        parsedTextContent ??
        (!trimmedContent.startsWith('{') && !trimmedContent.startsWith('[')
          ? { text: dto.content }
          : null);
      if (!textContent) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'invalid text message content',
        );
      }
      if (!textContent.text.trim()) {
        throw new BusinessException(BusinessCode.MESSAGE_EMPTY, 'no content');
      }
      if (hasUnpairedSurrogate(textContent.text)) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'text must contain valid Unicode',
        );
      }
      if (
        unicodeCodePointLength(textContent.text) > TEXT_MESSAGE_MAX_CODE_POINTS
      ) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          `text must be at most ${TEXT_MESSAGE_MAX_CODE_POINTS} Unicode code points`,
        );
      }
      dto.content = stringifyTextMessageContent({
        text: await this.canonicalizeMentions(req, textContent.text),
        ...(textContent.quote ? { quote: { seq: textContent.quote.seq } } : {}),
      });
    } else if (!dto.content?.trim()) {
      throw new BusinessException(BusinessCode.MESSAGE_EMPTY, 'no content');
    }
    // LINK content is an owned, completed in-memory generationId. Persist exactly the card the user
    // reviewed; never accept client-authored metadata or fetch the page again during send.
    if (contentType === ContentType.LINK) {
      generationId = dto.content;
      const content = this.linkPreview.consumeGeneration(
        req.user.userId,
        generationId,
      );
      if (!content) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'link card generation is not ready',
        );
      }
      dto.content = JSON.stringify(content);
      if (!parseLinkContent(dto.content)) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'invalid link content',
        );
      }
    }
    const quoteVisibility: {
      clearedThroughSeq?: number | null;
      hideCreators?: Array<{
        account: string;
        domain: string;
        namespaceId: number;
      }>;
    } = { clearedThroughSeq: req.threadAccess.clearedSeq };
    const hasQuote =
      contentType === ContentType.PURE_TEXT &&
      parseTextMessageContent(dto.content)?.quote !== undefined;
    if (
      hasQuote &&
      req.threadAccess.threadType === 'P2P' &&
      req.threadAccess.participant.blocked
    ) {
      const peers = await this.participantService.findP2PPeers(
        [dto.threadId],
        req.user.userId,
      );
      if (peers.length > 0)
        quoteVisibility.hideCreators = peers.map((peer) => ({
          account: peer.account,
          domain: peer.domain,
          namespaceId: peer.namespaceId,
        }));
    }
    await this.userQuota.assertCanSend(req.user.userId);
    const data = await this.messageService.writeMsgToThread(
      req.user.userId,
      dto.threadId,
      dto.content,
      contentType,
      dto.clientMessageId,
      undefined,
      async (tx) => {
        await this.userQuota.tickLax(req.user.userId, 'messages', tx);
      },
      quoteVisibility,
    );
    if (generationId && !dto.retainLinkGeneration) {
      this.linkPreview.finishGeneration(req.user.userId, generationId);
    }
    return data;
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SendContactCardDto>('threadId')
  @Throttle('message.send')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('send-contact-card')
  @ApiOperation({ summary: 'Share an immutable user contact snapshot' })
  @ApiResultResponse(MessageResponseDto)
  async sendContactCard(
    @Request() req: FastifyRequest,
    @Body() dto: SendContactCardDto,
  ) {
    const prior = await this.messageService.findByClientMessageId(
      dto.clientMessageId,
    );
    if (prior) {
      if (
        !(await this.messageService.isAuthoredBy(
          prior.creator,
          req.user.userId,
        )) ||
        prior.threadId !== dto.threadId ||
        prior.contentType !== ContentType.CONTACT_CARD
      ) {
        throw new BusinessException(
          BusinessCode.VALIDATION_FAILED,
          'invalid clientMessageId',
        );
      }
      return prior;
    }
    if (
      (req.threadAccess.threadType === 'P2P' &&
        !req.threadAccess.friendshipActive) ||
      (req.threadAccess.threadType === 'GROUP' &&
        !req.threadAccess.membershipActive)
    ) {
      throw new BusinessException(
        req.threadAccess.threadType === 'GROUP'
          ? BusinessCode.GROUP_FORBIDDEN
          : BusinessCode.FRIEND_NOT_FOUND,
        'conversation is read-only',
      );
    }
    if (req.threadAccess.groupDissolved) {
      throw new BusinessException(
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    }
    if (req.threadAccess.threadType === 'GROUP') {
      await this.federation.assertGroupWritable(dto.threadId);
    } else {
      await this.federation.assertP2PWritable(dto.threadId, req.user.userId);
    }
    const reference = dto.target;
    await assertContactCardTargetVisible(req.user.userId, reference, {
      users: this.users,
      groups: this.groups,
      participants: this.participantService,
    });
    const profile = await this.contactProfiles.findProfile(reference);
    const avatar = profile?.avatar
      ? await this.forwardBundles.snapshotAvatarForMessage(profile.avatar)
      : null;
    await this.userQuota.assertCanSend(req.user.userId);
    const data = await this.messageService.writeMsgToThread(
      req.user.userId,
      dto.threadId,
      JSON.stringify({
        account: reference.account,
        domain: reference.domain,
        displayName: profile?.displayName || reference.account,
        bio: profile?.bio ?? '',
        ...(avatar
          ? {
              avatar: `/uploads/msg-assets/${avatar.digest.slice(0, 2)}/${avatar.digest.slice(2, 4)}/${avatar.digest}`,
            }
          : {}),
      }),
      ContentType.CONTACT_CARD,
      dto.clientMessageId,
      undefined,
      async (tx) => {
        await this.userQuota.tickLax(req.user.userId, 'messages', tx);
        if (avatar) await this.userQuota.tickLax(req.user.userId, 'files', tx);
      },
    );
    return data;
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SendForwardDto>('threadId')
  @Throttle('message.forward')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('send-forward')
  @ApiOperation({
    summary: 'Directly re-send one message or send a chat-record bundle',
  })
  @ApiResultResponse(MessageResponseDto)
  async sendForward(
    @Request() req: FastifyRequest,
    @Body() dto: SendForwardDto,
  ) {
    if (
      req.threadAccess.threadType === 'P2P' &&
      !req.threadAccess.friendshipActive
    ) {
      throw new BusinessException(BusinessCode.FRIEND_NOT_FOUND, 'not friends');
    }
    if (
      req.threadAccess.threadType === 'GROUP' &&
      !req.threadAccess.membershipActive
    ) {
      throw new BusinessException(BusinessCode.GROUP_FORBIDDEN, 'not a member');
    }
    if (req.threadAccess.groupDissolved) {
      throw new BusinessException(
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    }
    if (req.threadAccess.threadType === 'GROUP') {
      await this.federation.assertGroupWritable(dto.threadId);
    } else {
      await this.federation.assertP2PWritable(dto.threadId, req.user.userId);
    }
    const prior = await this.messageService.findByClientMessageId(
      dto.clientMessageId,
    );
    if (prior) return prior;
    if (dto.mode === ForwardMode.DIRECT) {
      if (dto.sourceMessages.length !== 1) {
        throw new BusinessException(
          BusinessCode.FORWARD_INVALID_BUNDLE,
          'direct forward requires exactly one source message',
        );
      }
      const direct = await this.forwardBundles.prepareDirectMessage(
        req.user.userId,
        dto.sourceMessages[0],
      );
      await this.userQuota.assertCanSend(req.user.userId);
      const data = await this.messageService.writeMsgToThread(
        req.user.userId,
        dto.threadId,
        direct.content,
        direct.contentType,
        dto.clientMessageId,
        direct.forwardBundleId,
        async (tx) => {
          await this.userQuota.tickLax(req.user.userId, 'messages', tx);
        },
      );
      return data;
    }
    const bundle = await this.forwardBundles.prepareFromMessages(
      req.user.userId,
      dto.sourceMessages,
    );
    await this.userQuota.assertCanSend(req.user.userId);
    const data = await this.messageService.writeMsgToThread(
      req.user.userId,
      dto.threadId,
      bundle.content,
      ContentType.FORWARD,
      dto.clientMessageId,
      bundle.bundleId,
      async (tx) => {
        // The outer forward is one sent message; each distinct bundled asset is one file.
        await this.userQuota.tickLax(req.user.userId, 'messages', tx, 1);
        if (bundle.assets.length > 0) {
          await this.userQuota.tickLax(
            req.user.userId,
            'files',
            tx,
            bundle.assets.length,
          );
        }
        await this.forwardBundles.persistPrepared(tx, bundle);
      },
    );
    return data;
  }

  @ApiBearerAuth()
  @Get('forward-bundles/:bundleId')
  @ApiOperation({
    summary: 'Read a visible FORWARD bundle and every nested child bundle',
  })
  getForwardBundle(
    @Request() req: FastifyRequest,
    @Param('bundleId') bundleId: string,
  ) {
    return this.forwardBundles.getClosureForUser(req.user.userId, bundleId);
  }

  /**
   * Treat only supported, unescaped v1 entities as mention semantics. User labels are rewritten from
   * the active roster; @all is owner/admin-only. This is the security boundary — hiding a candidate
   * in the composer is presentation, not authorization.
   */
  private async canonicalizeMentions(
    req: FastifyRequest,
    content: string,
  ): Promise<string> {
    const entities: Array<{
      entityType: 'user' | 'audience';
      entityId: string;
    }> = [];
    transformMessageEntities(content, (entity) => {
      if (
        entity.entityType === 'user' ||
        (entity.entityType === 'audience' && entity.entityId === 'all')
      ) {
        entities.push(entity);
      }
      return entity.raw;
    });
    if (entities.length === 0) return content;
    if (entities.length > 20) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'too many mentions (maximum 20)',
      );
    }
    if (req.threadAccess.threadType !== 'GROUP') {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'mentions are only supported in group conversations',
      );
    }

    const requestedMembers = new Map<
      string,
      { account: string; domain: string }
    >();
    for (const entity of entities) {
      if (entity.entityType !== 'user') continue;
      const separator = entity.entityId.lastIndexOf('@');
      if (separator <= 0 || separator === entity.entityId.length - 1) {
        throw new BusinessException(
          BusinessCode.GROUP_TARGET_NOT_MEMBER,
          `mention target must use an exact account@domain address: ${entity.entityId}`,
        );
      }
      requestedMembers.set(entity.entityId, {
        account: entity.entityId.slice(0, separator),
        domain: entity.entityId.slice(separator + 1),
      });
    }
    const resolvedMembers = new Map(
      await Promise.all(
        [...requestedMembers].map(
          async ([entityId, identity]) =>
            [
              entityId,
              await this.groups.resolveActiveMember(
                req.threadAccess.threadId,
                identity,
              ),
            ] as const,
        ),
      ),
    );
    return transformMessageEntities(content, (entity) => {
      if (entity.entityType === 'user') {
        const member = resolvedMembers.get(entity.entityId);
        if (!member) throw new Error('resolved mention member is missing');
        return serializeUserMention(
          member.name,
          `${member.account}@${member.domain}`,
        );
      }
      if (entity.entityType === 'audience' && entity.entityId === 'all') {
        const role = req.threadAccess.participant.role;
        if (role !== GroupRole.OWNER && role !== GroupRole.ADMIN) {
          throw new BusinessException(
            BusinessCode.GROUP_FORBIDDEN,
            'only group owners and admins may mention everyone',
          );
        }
        return serializeAudienceMention(entity.label, 'all');
      }
      return entity.raw;
    });
  }

  /**
   * Stage a media message BEFORE its file is uploaded. Creates a PendingMedia(pending) row keyed by
   * clientMessageId (carrying any client-probed display meta) — durable intent recorded BEFORE the file
   * write, so a crash between staging and upload leaves an attributable record, never the unattributed
   * orphan the old upload-then-send order produced. No Message or seq is created; nothing is fanned
   * out. The client follows this with POST /upload* (carrying the same clientMessageId) which writes
   * the file and promotes the stage to a real Message (the promote path runs the fan-out).
   *
   * Membership is resolved by ThreadAccessGuard (THREAD_NOT_FOUND for non-participants), same as text.
   * Idempotent: a retried stage with the same clientMessageId returns the existing stage.
   */
  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SendMediaDto>('threadId')
  @Throttle('message.media-stage')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('send-media')
  @ApiOperation({
    summary: 'Stage a media message (before upload); promoted on POST /upload*',
  })
  @ApiResultResponse(MessageResponseDto)
  async sendMedia(@Request() req: FastifyRequest, @Body() dto: SendMediaDto) {
    if (!req.threadAccess.membershipActive) {
      throw new BusinessException(
        req.threadAccess.threadType === 'P2P'
          ? BusinessCode.FRIEND_NOT_FOUND
          : BusinessCode.GROUP_FORBIDDEN,
        'conversation is read-only',
      );
    }
    if (req.threadAccess.groupDissolved) {
      throw new BusinessException(
        BusinessCode.GROUP_DISSOLVED,
        'group has been dissolved',
      );
    }
    if (req.threadAccess.threadType === 'GROUP') {
      await this.federation.assertGroupWritable(dto.threadId);
    } else {
      await this.federation.assertP2PWritable(dto.threadId, req.user.userId);
    }
    // Phase 7: stage only message-level intent + fileCnt. Per-file display metadata (w/h/duration)
    // rides with each upload part; the daily file cnt + byte quota is charged at upload admission
    // (UploadController.admitUpload), where the real byte size is known — not here.
    await this.userQuota.assertCanSend(req.user.userId);
    await this.messageService.stageMedia(
      req.user.userId,
      dto.threadId,
      dto.contentType,
      dto.clientMessageId,
      dto.fileCnt ?? 1,
      dto.retry === true,
    );
    return { clientMessageId: dto.clientMessageId };
  }

  @UseGuards(ThreadAccessGuard)
  @ResourceId<QueryMediaStagesDto>('threadId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('query-media-stages')
  @ApiOperation({
    summary:
      'Query the current user’s uncommitted media-send states in a conversation',
  })
  async queryMediaStages(
    @Request() req: FastifyRequest,
    @Body() dto: QueryMediaStagesDto,
  ) {
    return this.messageService.queryMediaStages(req.user.userId, dto.threadId);
  }

  @UseGuards(ThreadAccessGuard)
  @ResourceId<AbandonMediaStageDto>('threadId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('abandon-media-stage')
  @ApiOperation({
    summary: 'Abandon one uncommitted local media-send stage',
  })
  async abandonMediaStage(
    @Request() req: FastifyRequest,
    @Body() dto: AbandonMediaStageDto,
  ) {
    return this.messageService.abandonMediaStage(
      req.user.userId,
      dto.threadId,
      dto.clientMessageId,
    );
  }

  @UseGuards(ThreadAccessGuard)
  @ResourceId<QueryMessagesDto>('threadId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('query-messages')
  @ApiOperation({
    summary: 'Query conversation history messages (cursor pagination)',
  })
  @ApiResultResponse(MessageQueryPageDto)
  async queryMessages(
    @Request() req: FastifyRequest,
    @Body() dto: QueryMessagesDto,
  ) {
    if (dto.after !== undefined && dto.before !== undefined)
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'after and before are mutually exclusive',
        HttpStatus.BAD_REQUEST,
      );
    if (
      dto.after === undefined &&
      dto.before === undefined &&
      (dto.through !== undefined || dto.take !== undefined)
    )
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'take and through require after or before',
        HttpStatus.BAD_REQUEST,
      );
    const { after, before, through } = dto;
    if (after !== undefined && through !== undefined && through < after)
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'through must be greater than or equal to after',
        HttpStatus.BAD_REQUEST,
      );
    if (before !== undefined && through !== undefined && through > before)
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'through must be less than or equal to before',
        HttpStatus.BAD_REQUEST,
      );
    return this.messageService.queryClientMessagePage(req.user.userId, {
      threadId: dto.threadId,
      after,
      before,
      through,
      take: dto.take ?? 20,
    });
  }

  @UseGuards(ThrottleGuard)
  @ResourceId<MarkReadDto>('threadId')
  @Throttle('thread.mark-read')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/mark-read')
  @ApiOperation({
    summary: 'Commit a local read HWM',
  })
  @ApiResultResponse(ThreadReadPositionResultDto)
  async markRead(@Request() req: FastifyRequest, @Body() dto: MarkReadDto) {
    const outcome = await this.readPositions.execute(req.user.userId, dto);
    if (isBusinessRejection(outcome))
      return businessEnvelope(outcome.code, outcome.message, {
        status: outcome.status,
        reason: outcome.reason,
      });
    return outcome;
  }

  @UseGuards(ThrottleGuard)
  @Throttle('thread.feed-delta')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread-feed')
  @ApiResultResponse(ThreadFeedPageDto)
  @ApiOperation({
    summary: 'Fetch unified thread snapshots in a bounded feed range',
  })
  async threadFeed(
    @Request() req: FastifyRequest,
    @Body() dto: ThreadFeedQueryDto,
  ) {
    return this.attention.queryThreadFeedDelta(req.user.userId, dto);
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SetMutedDto>('threadId')
  @Throttle('thread.set-muted')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/set-muted')
  @ApiOperation({
    summary:
      'Mute / unmute a conversation (suppresses notifications, not delivery)',
  })
  async setMuted(
    @Request() req: FastifyRequest,
    @Body() dto: SetMutedDto,
  ): Promise<void> {
    await this.participantService.setMuted(
      req.user.userId,
      dto.threadId,
      dto.muted,
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SetBlockedDto>('threadId')
  @Throttle('thread.set-blocked')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/set-blocked')
  @ApiOperation({
    summary: 'Block / unblock new-message delivery for one conversation',
  })
  async setBlocked(
    @Request() req: FastifyRequest,
    @Body() dto: SetBlockedDto,
  ): Promise<void> {
    await this.participantService.setBlocked(
      req.user.userId,
      dto.threadId,
      dto.blocked,
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SetPinnedDto>('threadId')
  @Throttle('thread.set-pinned')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/set-pinned')
  @ApiOperation({
    summary: 'Pin / unpin a conversation (pinned-first ordering)',
  })
  async setPinned(
    @Request() req: FastifyRequest,
    @Body() dto: SetPinnedDto,
  ): Promise<void> {
    await this.participantService.setPinned(
      req.user.userId,
      dto.threadId,
      dto.pinned,
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SetAliasDto>('threadId')
  @Throttle('thread.set-alias')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/set-alias')
  @ApiResultResponse(ThreadAliasResultDto)
  @ApiOperation({
    summary:
      'Set a per-user alias/remark for a conversation (overrides the displayed name for the caller)',
  })
  async setAlias(
    @Request() req: FastifyRequest,
    @Body() dto: SetAliasDto,
  ): Promise<ThreadAliasResultDto> {
    return this.participantService.setAlias(
      req.user.userId,
      dto.threadId,
      dto.alias,
    );
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SearchMessagesDto>('threadId')
  @Throttle('message.search')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('search-messages')
  @ApiOperation({
    summary:
      'Search a conversation by substring (returns lightweight match ids for kernel jump)',
  })
  async searchMessages(
    @Request() req: FastifyRequest,
    @Body() dto: SearchMessagesDto,
  ) {
    // Membership is resolved by ThreadAccessGuard (THREAD_NOT_FOUND for non-participants). The match
    // list excludes blocked/muted indirectly: blocked creators' messages are already hidden at the
    // source by the send fan-out. The thread-wide clearedSeq filters both count and page in SQL;
    // the client jumps the kernel to returned seqs. take+1 determines hasMore.
    const lastSeq = dto.lastSeq !== undefined ? Number(dto.lastSeq) : undefined;
    const { rows, totalCount } = await this.messageService.searchMessages(
      dto.threadId,
      dto.keyword,
      dto.take,
      lastSeq,
      req.threadAccess.clearedSeq,
    );
    const hasMore = rows.length > dto.take;
    const data = hasMore ? rows.slice(0, dto.take) : rows;
    return envelope(data, { hasMore, totalCount });
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<RelocalizeMediaDto>('threadId')
  @Throttle('message.relocalize-media')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('relocalize-media')
  @ApiOperation({
    summary:
      'Manually re-run federated media localize for one message (retry after a localize failure)',
  })
  async relocalizeMedia(
    @Request() req: FastifyRequest,
    @Body() dto: RelocalizeMediaDto,
  ) {
    // The user supplies only the carrier message. Its server-authored MediaMessage/ForwardMessage
    // bindings determine every remote digest fetched; arbitrary CAS URLs/digests are never accepted.
    const status = await this.federation.localizeMediaForMessage(
      req.user.userId,
      req.threadAccess.threadId,
      dto.seq,
    );
    return { status };
  }

  @Raw()
  @ApiBearerAuth()
  @Sse('message/media-message-progress')
  async mediaMessageProgress(
    @Request() req: FastifyRequest,
    @Query() dto: MediaMessageProgressDto,
  ): Promise<Observable<MessageEvent>> {
    const { threadId, seq } = await this.authorizeMediaProgress(
      req.user.userId,
      dto,
    );
    return this.sse.registerMediaMessageProgress(req.user.userId, threadId, seq);
  }

  @Raw()
  @ApiBearerAuth()
  @Sse('message/media-file-progress')
  async mediaFileProgress(
    @Request() req: FastifyRequest,
    @Query() dto: MediaFileProgressDto,
  ): Promise<Observable<MessageEvent>> {
    const { threadId, seq } = await this.authorizeMediaProgress(
      req.user.userId,
      dto,
    );
    const digest = typeof dto.digest === 'string' ? dto.digest.trim() : '';
    if (!/^[0-9a-f]{64}$/i.test(digest)) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'digest must be a 64-character hex string',
      );
    }
    if (!(await this.messageService.hasMessageMediaDigest(threadId, seq, digest))) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'media not found');
    }
    return this.sse.registerMediaFileProgress(
      req.user.userId,
      threadId,
      seq,
      digest.toLowerCase(),
    );
  }

  private async authorizeMediaProgress(
    userId: number,
    dto: MediaMessageProgressDto,
  ): Promise<{ threadId: number; seq: number }> {
    const threadId = Number(dto.threadId);
    const seq = Number(dto.seq);
    if (!Number.isSafeInteger(threadId) || threadId < 1) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'threadId must be a positive integer',
      );
    }
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'seq must be a positive integer',
      );
    }
    const participant =
      await this.participantService.findActiveParticipantWithThread(
        userId,
        threadId,
      );
    if (participant === null) {
      throw new BusinessException(
        BusinessCode.THREAD_NOT_FOUND,
        `no thread [${threadId}]`,
      );
    }
    const status = await this.messageService.queryMediaStatus(threadId, [seq]);
    if (status.length === 0) {
      throw new BusinessException(BusinessCode.NOT_FOUND, 'media not found');
    }
    return { threadId, seq };
  }

  @UseGuards(ThreadAccessGuard)
  @ResourceId<MediaStatusDto>('threadId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('media-status')
  @ApiOperation({
    summary: 'Read federated media status for mounted messages',
  })
  async mediaStatus(@Body() dto: MediaStatusDto) {
    // No ThrottleGuard: a cheap batched read fired on mount and SSE reconnect. ThreadAccessGuard
    // scopes threadId; missing or withdrawn seqs are omitted.
    const statuses = await this.messageService.queryMediaStatus(
      dto.threadId,
      dto.seqs,
    );
    return { statuses };
  }
}
