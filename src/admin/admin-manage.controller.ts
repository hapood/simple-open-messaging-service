import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';
import { AdminManageService } from './admin-manage.service.js';
import { AdminRole } from '../prisma/generated/client.js';
import {
  AdminManageListDto,
  AdminCreateDto,
  AdminSetRoleDto,
} from './admin.dto.js';

/**
 * Admin self-management (SUPER_ADMIN only — the whole controller is gated). HTTP adapter over
 * AdminManageService: list/promote/disable + assign roles. Disabling or demoting an admin revokes
 * their sessions immediately (tokenVersion bump inside the last-super-guarded transaction +
 * refresh-family revocation). The last enabled SUPER_ADMIN can never be disabled or demoted.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Roles(AdminRole.SUPER_ADMIN)
@Public()
@Controller()
export class AdminManageController {
  constructor(private readonly svc: AdminManageService) {}

  @HttpCode(HttpStatus.OK)
  @Post('admin/admins')
  @ApiOperation({ summary: 'Admin account list (paginated + searchable)' })
  async list(@Body() dto: AdminManageListDto) {
    return this.svc.list(dto);
  }

  @Audit('admin.create', { targetType: 'admin' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/admins/create')
  @ApiOperation({ summary: 'Promote an existing User to an admin' })
  async create(@Body() dto: AdminCreateDto) {
    return this.svc.create(dto);
  }

  @Audit('admin.disable', { targetType: 'admin', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/admins/:id/disable')
  @ApiOperation({ summary: 'Disable an admin (revokes all their sessions immediately)' })
  async disable(@Param('id') id: string) {
    return this.svc.disable(Number(id));
  }

  @Audit('admin.enable', { targetType: 'admin', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/admins/:id/enable')
  @ApiOperation({ summary: 'Re-enable a disabled admin' })
  async enable(@Param('id') id: string) {
    return this.svc.enable(Number(id));
  }

  @Audit('admin.role', { targetType: 'admin', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/admins/:id/role')
  @ApiOperation({ summary: "Change an admin's role (demotion revokes their sessions)" })
  async setRole(@Param('id') id: string, @Body() dto: AdminSetRoleDto) {
    return this.svc.setRole(Number(id), dto);
  }
}
