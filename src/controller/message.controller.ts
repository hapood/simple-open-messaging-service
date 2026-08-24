import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import {
  MessageService,
  type MessageQueryParams,
} from '../message/message.service.js';
import { ContentType, GroupRole } from '../database/enums.js';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { ApiResultResponse, envelope } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { MessageResponseDto } from '../dto/response.dto.js';
import { UserIdDto } from '../dto/user.dto.js';
import { UserService } from '../user/user.service.js';
import { GroupService } from '../group/group.service.js';
import { SseService } from '../gateway/sse.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { ThreadAccessGuard } from '../thread-participant/thread-access.guard.js';
import { ResourceId } from '../common/resource-id.decorator.js';
import { parseLinkContent } from '../upload/file-content.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { FederationService } from '../federation/federation.service.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import {
  SendMessageDto,
  SendMediaDto,
  QueryMediaStagesDto,
  QueryMessagesDto,
  MarkReadDto,
  ReadDeltaDto,
  MediaStatusDto,
  RelocalizeMediaDto,
  SetMutedDto,
  SetBlockedDto,
  SetPinnedDto,
  ClearHistoryDto,
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
import { DeletedMessageService } from '../message/deleted-message.service.js';
import { MessageReportService } from '../message/message-report.service.js';
import { CreateMessageReportsDto } from '../message/message-report.dto.js';
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
    private readonly sseService: SseService,
    private readonly participantService: ThreadParticipantService,
    private readonly fanout: MessageFanoutService,
    private readonly federation: FederationService,
    private readonly linkPreview: LinkPreviewService,
    private readonly forwardBundles: ForwardBundleService,
    private readonly userQuota: UserQuotaService,
    private readonly deletedMessages: DeletedMessageService,
    private readonly messageReports: MessageReportService,
    private readonly users: UserService,
    private readonly groups: GroupService,
  ) {}

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<CreateMessageReportsDto>('threadId')
  @Throttle('message.report')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('message-reports')
  @ApiOperation({ summary: 'Report one or more messages in one conversation' })
  async reportMessages(
    @Request() req: FastifyRequest,
    @Body() dto: CreateMessageReportsDto,
  ) {
    return this.messageReports.create(req.user.userId, dto);
  }

  @UseGuards(ThreadAccessGuard)
  @ResourceId<QueryDeletedMessagesDto>('threadId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('deleted-messages/query')
  @ApiOperation({
    summary: 'Query one conversation deletion log after its HWM',
  })
  async queryDeletedMessages(@Body() dto: QueryDeletedMessagesDto) {
    const rows = await this.deletedMessages.queryThread(
      dto.threadId,
      BigInt(dto.afterId),
      dto.take,
    );
    return envelope(rows, { hasMore: rows.length === dto.take });
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
    const participants =
      await this.participantService.getActiveParticipantUserIds(dto.threadId);
    for (const participant of participants) {
      this.sseService.onDeletedMessageUpdated(
        participant.userId,
        dto.threadId,
        deleted.id,
      );
    }
    if (deleted.systemMessage) void this.fanout.dispatch(deleted.systemMessage);
    // The existing federation hint is only a wake-up signal. Receivers always pull both the message
    // stream and the durable deletion stream, so reusing it keeps delivery lossy-safe without making
    // the push itself authoritative.
    void this.federation.notifyOnSend(req.user.userId, dto.threadId, dto.seq);
    void this.federation.signalDeletionOutbound(dto.threadId, dto.seq);
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
          prior.creator !== req.user.userId ||
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
      hideCreatorIds?: number[];
    } = { clearedThroughSeq: req.threadAccess.participant.clearedSeq };
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
        quoteVisibility.hideCreatorIds = peers.map((peer) => peer.userId);
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
    // Fire-and-forget: the response confirms PERSISTENCE (the row is committed above); recipient
    // fan-out (SSE + push + notif + federation hint) runs off the request critical path. The client
    // reconciles by seq/id, so an SSE frame landing after the 200 is harmless. The staged-media promote
    // path uses the same dispatch, so text and media fan out identically.
    void this.fanout.dispatch(data);
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
        prior.creator !== req.user.userId ||
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
    if (
      (dto.targetUserId === undefined) ===
      (dto.targetGroupId === undefined)
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'exactly one contact-card target is required',
      );
    }
    const groupVisibility =
      dto.targetGroupId === undefined
        ? null
        : await this.participantService.findActiveParticipantWithThread(
            req.user.userId,
            dto.targetGroupId,
          );
    const groupTarget =
      dto.targetGroupId === undefined ||
      groupVisibility?.thread.type !== 'GROUP' ||
      groupVisibility.messageVisibleBeforeSeq !== null
        ? null
        : await this.groups.findGroupByThreadId(dto.targetGroupId);
    const target =
      dto.targetUserId === undefined
        ? groupTarget?.groupUser
        : await this.users.findUniqueUser({
            id: dto.targetUserId,
            isDeleted: false,
          });
    if (!target) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'contact user not found',
      );
    }
    const avatar = target.avatar
      ? await this.forwardBundles.snapshotAvatarForMessage(target.avatar)
      : null;
    await this.userQuota.assertCanSend(req.user.userId);
    const data = await this.messageService.writeMsgToThread(
      req.user.userId,
      dto.threadId,
      JSON.stringify({
        account: target.account,
        domain: target.domain,
        displayName: target.name,
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
    void this.fanout.dispatch(data);
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
      void this.fanout.dispatch(data);
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
    void this.fanout.dispatch(data);
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

    const roster = await this.participantService.getRoster(
      req.threadAccess.threadId,
    );
    return transformMessageEntities(content, (entity) => {
      if (entity.entityType === 'user') {
        const separator = entity.entityId.lastIndexOf('@');
        const requestedAccount =
          separator < 0 ? entity.entityId : entity.entityId.slice(0, separator);
        const requestedDomain =
          separator < 0 ? null : entity.entityId.slice(separator + 1);
        const matches = roster.filter(({ user }) => {
          return (
            user.account === requestedAccount &&
            (requestedDomain === null ||
              user.domain === requestedDomain ||
              (user.domain === 'local' &&
                requestedDomain === this.federation.ourDomain))
          );
        });
        if (matches.length !== 1) {
          throw new BusinessException(
            BusinessCode.GROUP_TARGET_NOT_MEMBER,
            `mention target is not a unique active member: ${entity.entityId}`,
          );
        }
        const user = matches[0].user;
        return serializeUserMention(
          user.name,
          `${user.account}@${user.domain}`,
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
  @ResourceId<QueryMessagesDto>('threadId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('query-messages')
  @ApiOperation({
    summary: 'Query conversation history messages (cursor pagination)',
  })
  @ApiResultResponse(MessageResponseDto, true)
  async queryMessages(
    @Request() req: FastifyRequest,
    @Body() dto: QueryMessagesDto,
  ) {
    if (dto.truncate && dto.truncateSeq === undefined) {
      return envelope([], { hasMore: false, truncated: true });
    }
    if (
      dto.truncate &&
      dto.truncateSeq !== undefined &&
      dto.lastSeq !== undefined &&
      ((dto.orderBy === 'asc' && dto.truncateSeq <= dto.lastSeq) ||
        (dto.orderBy === 'desc' && dto.truncateSeq >= dto.lastSeq))
    ) {
      return envelope([], { hasMore: false, truncated: true });
    }
    // Membership is resolved by ThreadAccessGuard (THREAD_NOT_FOUND for non-participants) — the same
    // IDOR fix as send, now declarative. The participant row is on req.threadAccess.participant.
    // take+1 trick: fetch one extra row to decide hasMore, then truncate `data` back to `take` rows.
    // This removes the edge case where a total count that is an exact multiple of `take` would make the
    // client fire one speculative empty request (its `< take` heuristic would otherwise be ambiguous).
    const newParams: MessageQueryParams = {
      skip: dto.skip,
      take: dto.take + 1,
      orderBy: { seq: dto.orderBy },
    };
    if (dto.lastSeq !== undefined) {
      // seq is unique only within a thread, so the keyset cursor uses the compound (threadId, seq) unique.
      newParams.cursor = {
        threadId_seq: { threadId: dto.threadId, seq: Number(dto.lastSeq) },
      };
    }
    if (dto.truncate && dto.truncateSeq !== undefined) {
      newParams.truncateSeq = dto.truncateSeq;
    }
    // Blocking does not alter stored history. The client deliberately skips this request while a thread
    // is blocked and can query the retained history again after unblocking.
    const filters: {
      clearedThroughSeq?: number | null;
      visibleBeforeSeq?: number | null;
      hideCreatorIds?: number[];
    } = {
      clearedThroughSeq: req.threadAccess.participant.clearedSeq,
      visibleBeforeSeq: req.threadAccess.participant.messageVisibleBeforeSeq,
    };
    const rows = await this.messageService.queryMessages(
      dto.threadId,
      newParams,
      filters,
    );
    const hasMore = rows.length > dto.take;
    // The truncate row is deliberately EXCLUDED: it already exists locally. take+1 makes exhaustion of
    // the bounded interval unambiguous, including the exact-multiple case.
    const truncated = dto.truncate === true && !hasMore;
    const data = hasMore ? rows.slice(0, dto.take) : rows;
    return envelope(data, { hasMore, truncated });
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/by-user-id')
  @ApiOperation({
    summary: 'Look up the P2P thread by peer userId (friends only)',
  })
  async getThreadByUserId(
    @Request() req: FastifyRequest,
    @Body() dto: UserIdDto,
  ) {
    // A friend relationship == an active P2P thread shared by both. No thread → THREAD_NOT_FOUND,
    // deliberately non-leaking (a caller cannot probe a pending invite or prior relationship), the
    // same policy ThreadAccessGuard enforces.
    const threadId = await this.participantService.findP2PThreadBetween(
      req.user.userId,
      dto.userId,
    );
    if (threadId === null) {
      throw new BusinessException(
        BusinessCode.THREAD_NOT_FOUND,
        `no relationship with user [${dto.userId}]`,
      );
    }
    return { threadId };
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<MarkReadDto>('threadId')
  @Throttle('thread.mark-read')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/mark-read')
  @ApiOperation({
    summary: 'Commit a local read HWM',
  })
  async markRead(
    @Request() req: FastifyRequest,
    @Body() dto: MarkReadDto,
  ): Promise<void> {
    // Membership is resolved by ThreadAccessGuard (THREAD_NOT_FOUND for non-participants); the
    // participant row is on req.threadAccess.participant.
    const msg = await this.messageService.findMessageBySeq(
      dto.threadId,
      dto.localReadHwm,
    );
    if (msg === null) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        `no such message in thread [${dto.threadId}]`,
      );
    }
    const state = await this.messageService.commitReadState(
      req.user.userId,
      dto.threadId,
      msg.seq,
    );
    if (state)
      this.sseService.onThreadAttentionRevisionUpdated(req.user.userId, {
        attentionRevision: state.readRevision,
      });
  }

  @UseGuards(ThrottleGuard)
  @Throttle('thread.read-delta')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/read-delta')
  @ApiOperation({
    summary: 'Fetch read-state delta in (fromRevision, toRevision]',
  })
  async readDelta(@Request() req: FastifyRequest, @Body() dto: ReadDeltaDto) {
    const current = await this.messageService.currentReadRevision(
      req.user.userId,
    );
    const toRevision = Math.min(dto.toRevision, current);
    if (toRevision <= dto.fromRevision)
      return { readRevision: toRevision, items: [] };
    return {
      readRevision: toRevision,
      items: await this.messageService.queryReadDelta(
        req.user.userId,
        dto.fromRevision,
        toRevision,
      ),
    };
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
  @ResourceId<ClearHistoryDto>('threadId')
  @Throttle('thread.clear-history')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/clear-history')
  @ApiOperation({
    summary:
      'Clear chat history for me (hides all messages up to now; peer copy untouched)',
  })
  async clearHistory(
    @Request() req: FastifyRequest,
    @Body() dto: ClearHistoryDto,
  ): Promise<void> {
    await this.participantService.clearHistory(req.user.userId, dto.threadId);
  }

  @UseGuards(ThrottleGuard, ThreadAccessGuard)
  @ResourceId<SetAliasDto>('threadId')
  @Throttle('thread.set-alias')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('thread/set-alias')
  @ApiOperation({
    summary:
      'Set a per-user alias/remark for a conversation (overrides the displayed name for the caller)',
  })
  async setAlias(
    @Request() req: FastifyRequest,
    @Body() dto: SetAliasDto,
  ): Promise<void> {
    await this.participantService.setAlias(
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
  async searchMessages(@Body() dto: SearchMessagesDto) {
    // Membership is resolved by ThreadAccessGuard (THREAD_NOT_FOUND for non-participants). The match
    // list excludes blocked/muted indirectly: blocked creators' messages are already hidden at the
    // source by the send fan-out, and clearedSeq only affects the user's own view — search returns the
    // raw id matches; the client jumps the kernel, which loads each via query-messages (re-applying
    // clearedSeq/block). take+1 hasMore trick.
    const lastSeq = dto.lastSeq !== undefined ? Number(dto.lastSeq) : undefined;
    const rows = await this.messageService.searchMessages(
      dto.threadId,
      dto.keyword,
      dto.take,
      lastSeq,
    );
    const hasMore = rows.length > dto.take;
    const data = hasMore ? rows.slice(0, dto.take) : rows;
    return envelope(data, { hasMore });
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

  @UseGuards(ThreadAccessGuard)
  @ResourceId<MediaStatusDto>('threadId')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('media-status')
  @ApiOperation({
    summary:
      'Bulk-probe federated media localize status (scroll backstop for missed MEDIA_STATUS frames)',
  })
  async mediaStatus(@Body() dto: MediaStatusDto) {
    // No ThrottleGuard: a cheap read (two batched queries), fired only on scroll when the viewport
    // exposes non-ready media. ThreadAccessGuard scopes threadId; missing seqs are omitted.
    const statuses = await this.messageService.queryMediaStatus(
      dto.threadId,
      dto.seqs,
    );
    return { statuses };
  }
}
