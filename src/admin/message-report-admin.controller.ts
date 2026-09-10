import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/public.decorator.js';
import { AdminRole } from '../database/enums.js';
import {
  AdminListMessageReportsDto,
  MessageTargetDto,
} from '../message/message-report.dto.js';
import { MessageReportService } from '../message/message-report.service.js';
import { DeletedMessageService } from '../message/deleted-message.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Public()
@Controller('admin')
export class MessageReportAdminController {
  constructor(
    private readonly reports: MessageReportService,
    private readonly deletions: DeletedMessageService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('message-reports')
  @ApiOperation({ summary: 'List message reports' })
  list(@Body() dto: AdminListMessageReportsDto) {
    return this.reports.list(dto);
  }

  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('message_report.dismiss', { targetType: 'message_report' })
  @HttpCode(HttpStatus.OK)
  @Post('message-reports/delete')
  @ApiOperation({
    summary: 'Soft-delete one report without deleting its message',
  })
  dismiss(@Body() dto: MessageTargetDto) {
    return this.reports.dismiss(dto);
  }

  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('message.delete', { targetType: 'message' })
  @HttpCode(HttpStatus.OK)
  @Post('messages/delete')
  @ApiOperation({ summary: 'Delete one message and enqueue content fanout' })
  deleteMessage(@Body() dto: MessageTargetDto) {
    return this.deletions.deleteByModeration(dto.threadId, dto.seq);
  }
}
