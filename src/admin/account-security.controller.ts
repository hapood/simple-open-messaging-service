import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../common/public.decorator.js';
import { Throttle, ThrottleGuard } from '../rate-limit/throttle.guard.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AccountSecurityService } from './account-security.service.js';
import {
  AdminChangePasswordDto,
  SecurityAssertionDto,
} from './account-security.dto.js';
import { Audit } from './audit.decorator.js';

@Public()
@UseGuards(AdminAuthGuard, ThrottleGuard)
@Throttle('admin.two-factor')
@Controller('admin/account')
export class AccountSecurityController {
  constructor(private readonly security: AccountSecurityService) {}
  @Post('current')
  @HttpCode(200)
  current(@Req() req: FastifyRequest) {
    return this.security.current(
      req.user.adminId!,
      req.user.sessionId!,
      req.ip,
    );
  }
  @Post('assertion')
  @HttpCode(200)
  assertion(@Req() req: FastifyRequest, @Body() dto: SecurityAssertionDto) {
    return this.security.beginAssertion(
      req.user.adminId!,
      req.user.sessionId!,
      dto.action,
      dto.password,
      dto.target,
    );
  }
  @Audit('admin.change_password', { targetType: 'admin' })
  @Post('password')
  @HttpCode(200)
  password(@Req() req: FastifyRequest, @Body() dto: AdminChangePasswordDto) {
    return this.security.mutate(
      req.user.adminId!,
      req.user.sessionId!,
      'password',
      dto,
      dto.newPassword,
    );
  }
}
