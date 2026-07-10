import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { GroupManageService } from './group-manage.service.js';
import { AdminGroupsListDto } from './admin.dto.js';

/**
 * Read-only group/thread observability. HTTP adapter over GroupManageService. Lists GROUP threads
 * with member counts + federation origin (local + federated). Open to every admin role (incl.
 * VIEWER); destructive group ops (dissolve/transfer) are a follow-up.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller()
export class GroupManageController {
  constructor(private readonly svc: GroupManageService) {}

  @HttpCode(HttpStatus.OK)
  @Post('admin/groups')
  @ApiOperation({ summary: 'Group threads list (member count + owner + federation origin)' })
  async list(@Body() dto: AdminGroupsListDto) {
    return this.svc.list(dto);
  }
}
