import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../common/public.decorator.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { AdminRole } from '../database/enums.js';
import { LocalInformationService } from '../federation/self-check/local-information.service.js';
import {
  NetworkInspectionService,
  IP_SOURCE_IDS,
  type IpSource,
} from '../federation/self-check/network-inspection.service.js';
import { TargetNetworkDiagnosticsService } from '../federation/self-check/target-network-diagnostics.service.js';

export class NetworkTargetDto {
  @ApiProperty({
    example: 'example.com',
    description:
      'Federation domain only; the HTTPS host and port are discovered through SOMFP SRV.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(253)
  target!: string;
}

export class NetworkIpProbeDto {
  @ApiProperty({ enum: ['ip-sb', 'ipify', 'ident-me'] })
  @IsIn(IP_SOURCE_IDS)
  source!: IpSource;

  @ApiProperty({ enum: [4, 6] })
  @IsIn([4, 6])
  family!: 4 | 6;
}

@ApiTags('admin')
@Public()
@UseGuards(AdminAuthGuard)
@Controller()
export class AdminNetworkController {
  constructor(
    private readonly local: LocalInformationService,
    private readonly diagnostics: TargetNetworkDiagnosticsService,
    private readonly inspection: NetworkInspectionService,
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

  @Post('admin/network/info')
  @HttpCode(HttpStatus.OK)
  networkInfo() {
    return this.inspection.local();
  }

  @UseGuards(AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Post('admin/network/probe')
  @HttpCode(HttpStatus.OK)
  probe(@Body() dto: NetworkIpProbeDto) {
    return this.inspection.probe(dto.source, dto.family);
  }
}
