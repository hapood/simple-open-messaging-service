import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { Public } from '../common/public.decorator.js';
import { AdminRole } from '../database/enums.js';
import { TemporaryGarbageService } from '../media/temporary-garbage.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';

export class CleanTemporaryGarbageDto {
  @IsUUID()
  token!: string;

  @IsOptional()
  @IsBoolean()
  confirmDirectory = false;
}

@ApiTags('admin')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Roles(AdminRole.SUPER_ADMIN)
@Public()
@Controller('admin/garbage')
export class TemporaryGarbageAdminController {
  constructor(private readonly garbage: TemporaryGarbageService) {}

  @Post('scan')
  @HttpCode(200)
  scan() {
    return this.garbage.scan();
  }

  @Audit('media.temporary.clean', {
    targetType: 'temporary-garbage',
    targetBody: 'token',
  })
  @Post('clean')
  @HttpCode(200)
  clean(@Body() dto: CleanTemporaryGarbageDto) {
    return this.garbage.clean(dto.token, dto.confirmDirectory);
  }
}
