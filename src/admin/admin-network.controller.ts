import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../common/public.decorator.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { AdminRole } from '../database/enums.js';
import { LocalInformationService } from '../federation/self-check/local-information.service.js';
import { TargetNetworkDiagnosticsService } from '../federation/self-check/target-network-diagnostics.service.js';

export class NetworkTargetDto {
  @ApiProperty({ example: 'https://example.com:443' })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  target!: string;
}

@ApiTags('admin')
@Public()
@UseGuards(AdminAuthGuard)
@Controller()
export class AdminNetworkController {
  constructor(
    private readonly local: LocalInformationService,
    private readonly diagnostics: TargetNetworkDiagnosticsService,
  ) {}

  @Post('admin/local-information')
  @HttpCode(HttpStatus.OK)
  localInformation() {
    return this.local.get();
  }

  @UseGuards(AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Post('admin/network/diagnose')
  @HttpCode(HttpStatus.OK)
  diagnose(@Body() dto: NetworkTargetDto) {
    return this.diagnostics.run(dto.target);
  }
}
