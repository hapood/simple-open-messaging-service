import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { Public } from '../common/public.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { domainCommand } from '../database/schema.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminDomainCommandQueryDto } from './admin.dto.js';

/** Read-only operational history for durable domain commands. */
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@Controller()
export class DomainCommandAdminController {
  constructor(private readonly database: DatabaseService) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/domain-commands')
  @ApiOperation({
    summary: 'Domain command history (paginated and filterable)',
  })
  async list(@Body() dto: AdminDomainCommandQueryDto) {
    const search = dto.search?.trim();
    const where = and(
      dto.status ? eq(domainCommand.status, dto.status) : undefined,
      search
        ? or(
            ilike(domainCommand.commandType, `%${search}%`),
            ilike(domainCommand.aggregateKey, `%${search}%`),
          )
        : undefined,
    );
    const [list, total] = await Promise.all([
      this.database.db
        .select()
        .from(domainCommand)
        .where(where)
        .orderBy(desc(domainCommand.id))
        .offset(dto.skip ?? 0)
        .limit(dto.take ?? 50),
      this.database.db
        .select({ value: count() })
        .from(domainCommand)
        .where(where)
        .then(([row]) => row.value),
    ]);
    return { list, total };
  }
}
