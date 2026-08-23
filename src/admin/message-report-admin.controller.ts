import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Public } from '../common/public.decorator.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { AdminRole } from '../database/enums.js';
import { FederationService } from '../federation/federation.service.js';
import { SseService } from '../gateway/sse.service.js';
import {
  AdminListMessageReportsDto,
  ResolveMessageReportsDto,
} from '../message/message-report.dto.js';
import { MessageReportService } from '../message/message-report.service.js';
import { MessageFanoutService } from '../message/message-fanout.service.js';
import { ThreadParticipantService } from '../thread-participant/thread-participant.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Public()
@Controller('admin/message-reports')
export class MessageReportAdminController {
  constructor(
    private readonly reports: MessageReportService,
    private readonly participants: ThreadParticipantService,
    private readonly sse: SseService,
    private readonly federation: FederationService,
    private readonly fanout: MessageFanoutService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  @ApiOperation({ summary: 'List message reports' })
  list(@Body() dto: AdminListMessageReportsDto) {
    return this.reports.list(dto);
  }

  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('message_report.resolve', { targetType: 'message_report' })
  @HttpCode(HttpStatus.OK)
  @Post('resolve')
  @ApiOperation({ summary: 'Uphold or reject message reports' })
  async resolve(
    @Req() req: FastifyRequest,
    @Body() dto: ResolveMessageReportsDto,
  ) {
    const adminId = (req.user as { adminId?: number } | undefined)?.adminId;
    if (!adminId) {
      throw new BusinessException(
        BusinessCode.UNAUTHENTICATED,
        'no admin session',
      );
    }
    const result = await this.reports.resolve(adminId, dto);
    for (const deletion of result.deletions) {
      const participants = await this.participants.getActiveParticipantUserIds(
        deletion.threadId,
      );
      for (const participant of participants) {
        this.sse.onDeletedMessageUpdated(
          participant.userId,
          deletion.threadId,
          deletion.deletedId,
        );
      }
      void this.federation.notifyOnSend(
        deletion.creator,
        deletion.threadId,
        deletion.originSeq,
      );
      void this.federation.signalDeletionOutbound(
        deletion.threadId,
        deletion.seq,
      );
    }
    for (const systemMessage of result.systemMessages)
      void this.fanout.dispatch(systemMessage);
    return result;
  }
}
