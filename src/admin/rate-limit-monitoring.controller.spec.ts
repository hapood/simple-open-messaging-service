import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';
import type { RateLimitModeService } from '../rate-limit/rate-limit-mode.service.js';
import type { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { RateLimitMonitoringController } from './rate-limit-monitoring.controller.js';

describe('RateLimitMonitoringController', () => {
  it('is protected by the admin authentication guard', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, RateLimitMonitoringController),
    ).toContain(AdminAuthGuard);
  });

  it('returns configuration, aggregate samples, and deterministic advice', () => {
    const now = Date.now();
    const service = {
      monitoringSnapshot: vi.fn().mockReturnValue({
        current: { startedAt: now - 1_000, endedAt: now, policies: [] },
        history: [],
      }),
    } as unknown as RateLimitService;
    const modes = {
      monitoringConfig: vi.fn().mockReturnValue([
        {
          policy: 'auth.password.login',
          mode: 'shadow',
          buckets: [],
        },
      ]),
    } as unknown as RateLimitModeService;
    const result = new RateLimitMonitoringController(
      service,
      modes,
    ).getSnapshot();

    expect(result.policies[0]).toMatchObject({
      policy: 'auth.password.login',
      totals: { evaluated: 0 },
      advice: [{ code: 'insufficient-sample' }],
    });
  });
});
