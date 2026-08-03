import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/public.decorator.js';
import { AdminRole } from '../database/enums.js';
import { SaveLinkCardRuleDto } from '../link-preview/link-card-rule.dto.js';
import { LinkCardRuleService } from '../link-preview/link-card-rule.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';

@ApiTags('admin-link-card-rules')
@ApiBearerAuth()
@Public()
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/link-card-rules')
export class LinkCardRuleAdminController {
  constructor(private readonly rules: LinkCardRuleService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List all link card rules' })
  list() {
    return this.rules.listManaged();
  }

  @Post('create')
  @Audit('link_card_rule.create', { targetType: 'link_card_rule' })
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: SaveLinkCardRuleDto) {
    return this.rules.create(dto);
  }

  @Post(':id/update')
  @Audit('link_card_rule.update', {
    targetType: 'link_card_rule',
    targetParam: 'id',
  })
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SaveLinkCardRuleDto,
  ) {
    return this.rules.update(id, dto);
  }

  @Post(':id/delete')
  @Audit('link_card_rule.delete', {
    targetType: 'link_card_rule',
    targetParam: 'id',
  })
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.rules.remove(id);
  }
}
