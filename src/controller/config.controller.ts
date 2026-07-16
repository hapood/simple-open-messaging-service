import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/public.decorator.js';
import { ApiResult } from '../common/api-result.js';
import { BusinessCode } from '../common/business-code.js';
import { PUBLIC_CONFIG, PublicConfigDto } from '../config/public-config.js';

/**
 * Public, unauthenticated site configuration. Clients fetch this once at bootstrap (before rendering any
 * login UI) to learn whether self-registration is open and which login methods are enabled, so they show
 * the right login page and hide the register affordance when closed.
 *
 * Pure read over a hardcoded const (`PUBLIC_CONFIG`) — trivially cacheable, zero I/O. `@Public()` opts out
 * of the global `SessionAuthGuard`; the route sits under the existing `/api/v1` global prefix.
 */
@ApiTags('config')
@Public()
@Controller()
export class ConfigController {
  @Get('config')
  @ApiOperation({
    summary: 'Public site configuration (registration flag + enabled login methods).',
  })
  config(): ApiResult<PublicConfigDto> {
    return { code: BusinessCode.OK, message: 'successful', data: { ...PUBLIC_CONFIG } };
  }
}
