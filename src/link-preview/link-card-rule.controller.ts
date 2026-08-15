import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LinkCardRuleService } from './link-card-rule.service.js';

@ApiTags('link-card-rules')
@ApiBearerAuth()
@Controller()
export class LinkCardRuleController {
  constructor(private readonly rules: LinkCardRuleService) {}

  @Get('link-card-rules')
  @ApiOperation({
    summary: 'List enabled client-side link card hostname rules',
  })
  list() {
    return this.rules.list();
  }
}
