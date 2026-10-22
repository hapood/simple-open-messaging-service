import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/public.decorator.js';
import { RateLimitModeService } from '../rate-limit/rate-limit-mode.service.js';
import {
  RateLimitService,
  type RateLimitPolicyStats,
} from '../rate-limit/rate-limit.service.js';
import { rateLimitAdvice } from '../rate-limit/rate-limit-monitoring.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import { Roles } from './admin-roles.decorator.js';
import { Audit } from './audit.decorator.js';
import { AdminRole } from '../database/enums.js';
import { FixedWindowPolicyService } from '../rate-limit/fixed-window-policy.service.js';

@ApiTags('admin')
@ApiBearerAuth()
@Public()
@Controller('admin/rate-limits')
@UseGuards(AdminAuthGuard)
export class RateLimitMonitoringController {
  constructor(
    private readonly rateLimits: RateLimitService,
    private readonly modes: RateLimitModeService,
    private readonly fixedWindows: FixedWindowPolicyService,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Read authentication rate-limit configuration and aggregate metrics',
  })
  getSnapshot() {
    const now = Date.now();
    const monitoring = this.rateLimits.monitoringSnapshot(now);
    const intervals = [...monitoring.history, monitoring.current];
    return {
      generatedAt: now,
      intervalSeconds: 300,
      retentionIntervals: 288,
      fixedWindowPolicies: this.fixedWindows.list(),
      policies: this.modes.monitoringConfig().map((config) => {
        const samples = intervals.flatMap((interval) =>
          interval.policies
            .filter((stats) => stats.policy === config.policy)
            .map((stats) => ({
              ...stats,
              startedAt: interval.startedAt,
              endedAt: interval.endedAt,
            })),
        );
        const totals = samples.reduce(
          mergeStats,
          emptyStats(config.policy, config.mode),
        );
        const last = [...samples]
          .reverse()
          .find((sample) => sample.evaluated > 0);
        return {
          ...config,
          totals,
          samples,
          advice: rateLimitAdvice({
            ...totals,
            mode: config.mode,
            lastActivityAt: last?.endedAt,
            observationStartedAt:
              monitoring.history[0]?.startedAt ?? monitoring.current.startedAt,
            now,
          }),
        };
      }),
    };
  }

  @Post('fixed-window-configuration')
  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.rate-limits.fixed-window.save')
  @ApiOperation({ summary: 'Replace fixed-window route-limit configuration' })
  async setFixedWindowConfiguration(@Body() body: unknown) {
    try {
      return await this.fixedWindows.set(body);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message !== 'database is unavailable'
      ) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Post('configuration')
  @UseGuards(AdminAuthGuard, AdminRolesGuard)
  @Roles(AdminRole.ADMIN, AdminRole.SUPER_ADMIN)
  @Audit('settings.rate-limits.save')
  @ApiOperation({ summary: 'Replace authentication rate-limit configuration' })
  async setConfiguration(@Body() body: unknown) {
    try {
      return await this.modes.setConfiguration(body);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message !== 'database is unavailable'
      ) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

function emptyStats(
  policy: string,
  mode: RateLimitPolicyStats['mode'],
): RateLimitPolicyStats {
  return {
    policy,
    mode,
    evaluated: 0,
    allowed: 0,
    wouldBlock: 0,
    blocked: 0,
    observeOnlyExceeded: 0,
    maxRetryAfterMs: 0,
  };
}

function mergeStats(
  total: RateLimitPolicyStats,
  item: RateLimitPolicyStats,
): RateLimitPolicyStats {
  return {
    ...total,
    evaluated: total.evaluated + item.evaluated,
    allowed: total.allowed + item.allowed,
    wouldBlock: total.wouldBlock + item.wouldBlock,
    blocked: total.blocked + item.blocked,
    observeOnlyExceeded: total.observeOnlyExceeded + item.observeOnlyExceeded,
    maxRetryAfterMs: Math.max(total.maxRetryAfterMs, item.maxRetryAfterMs),
  };
}
