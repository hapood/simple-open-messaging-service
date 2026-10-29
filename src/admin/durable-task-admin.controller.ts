import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, count, desc, eq, getTableColumns, ilike, or } from 'drizzle-orm';
import { Public } from '../common/public.decorator.js';
import { DatabaseService } from '../database/database.service.js';
import { account, durableTask } from '../database/schema.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminDurableTaskQueryDto } from './admin.dto.js';

/** Read-only operational history for durable tasks. */
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@Controller()
export class DurableTaskAdminController {
  constructor(private readonly database: DatabaseService) {}

  @UseGuards(AdminAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('admin/durable-tasks')
  @ApiOperation({
    summary: 'Durable task history (paginated and filterable)',
  })
  async list(@Body() dto: AdminDurableTaskQueryDto) {
    const search = dto.search?.trim();
    const where = and(
      dto.status ? eq(durableTask.status, dto.status) : undefined,
      search
        ? or(
            ilike(durableTask.taskType, `%${search}%`),
            ilike(durableTask.scopeKey, `%${search}%`),
          )
        : undefined,
    );
    // Annotate the actor's account name so the console can label system-driven
    // rows with the reserved $system identity: actorUserId is mandatory, and the
    // $system singleton owns system-derived projection work and system-initiated
    // mutations. Those rows render as $system; user actors render as #id.
    const [list, total] = await Promise.all([
      this.database.db
        .select({ ...getTableColumns(durableTask), actorAccount: account.account })
        .from(durableTask)
        .leftJoin(account, eq(durableTask.actorUserId, account.id))
        .where(where)
        .orderBy(desc(durableTask.id))
        .offset(dto.skip ?? 0)
        .limit(dto.take ?? 50),
      this.database.db
        .select({ value: count() })
        .from(durableTask)
        .where(where)
        .then(([row]) => row.value),
    ]);
    return { list, total };
  }
}
