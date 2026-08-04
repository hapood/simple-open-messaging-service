import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/public.decorator.js';
import { RateLimitModeService } from '../rate-limit/rate-limit-mode.service.js';
import {
  RateLimitService,
  type RateLimitPolicyStats,
} from '../rate-limit/rate-limit.service.js';
import { rateLimitAdvice } from '../rate-limit/rate-limit-monitoring.js';
import { AdminAuthGuard } from './admin-auth.guard.js';

@ApiTags('admin')
@ApiBearerAuth()
@Public()
@Controller('admin/rate-limits')
@UseGuards(AdminAuthGuard)
export class RateLimitMonitoringController {
  constructor(
    private readonly rateLimits: RateLimitService,
    private readonly modes: RateLimitModeService,
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
