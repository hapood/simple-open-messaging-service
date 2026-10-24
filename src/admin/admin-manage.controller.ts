import type { FastifyRequest } from 'fastify';
import { Public } from '../common/public.decorator.js';
import {
  Controller,
  Post,
  Body,
  Param,
  ParseIntPipe,
  Req,
  ForbiddenException,
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
import { AdminRole } from '../database/enums.js';
import { AdminManageListDto, AdminSetRoleDto } from './admin.dto.js';

/**
 * Admin self-management (SUPER_ADMIN only — the whole controller is gated). HTTP adapter over
 * AdminManageService: list/promote/disable + assign roles. Disabling or demoting an admin revokes
 * their outstanding admin_session cookies (revokeSessionsByAdmin) so the next request fails
 * validation; a no-op same-role setRole revokes nothing. SUPER_ADMIN grants cannot be changed
 * through these management endpoints.
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

  @Audit('admin.grant_viewer', { targetType: 'user', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/users/:id/grant-viewer')
  @ApiOperation({ summary: 'Grant read-only admin access to an existing user' })
  async grantViewer(@Param('id', ParseIntPipe) id: number) {
    return this.svc.grantViewer(id);
  }

  @Audit('admin.disable', { targetType: 'admin', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/admins/:id/disable')
  @ApiOperation({
    summary: 'Disable an admin (revokes all their sessions immediately)',
  })
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
  @ApiOperation({
    summary: "Change an admin's role (demotion revokes their sessions)",
  })
  async setRole(@Param('id') id: string, @Body() dto: AdminSetRoleDto) {
    return this.svc.setRole(Number(id), dto);
  }

  @Audit('admin.reset_2fa', { targetType: 'admin', targetParam: 'id' })
  @HttpCode(HttpStatus.OK)
  @Post('admin/admins/:id/reset-2fa')
  @ApiOperation({
    summary:
      "Reset (disable) an admin's 2FA — lockout recovery when a device is lost",
  })
  async reset2fa(@Param('id') id: string, @Req() req: FastifyRequest) {
    if (Number(id) === req.user.adminId)
      throw new ForbiddenException(
        'use My Account to change your own second factor',
      );
    return this.svc.resetTwoFactor(Number(id));
  }
}
