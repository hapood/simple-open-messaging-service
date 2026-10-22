import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/public.decorator.js';
import { Throttle, ThrottleGuard } from '../rate-limit/throttle.guard.js';
import { ClientCompatService } from './client-compat.service.js';
import { ClientCompatDto } from './client-compat.dto.js';

/** Pre-login client bootstrap configuration. */
@ApiTags('client')
@Public()
@UseGuards(ThrottleGuard)
@Controller('client')
export class ClientCompatController {
  constructor(private readonly clientCompat: ClientCompatService) {}

  @Get('compat')
  @Throttle('client.compat')
  @ApiOperation({
    summary:
      'Client API version, server version and public client configuration.',
  })
  compat(): ClientCompatDto {
    return this.clientCompat.compat();
  }
}
