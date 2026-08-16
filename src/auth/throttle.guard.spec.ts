import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { KvStoreService } from '../kv-store/kv-store.service.js';
import type { ClientIdentityService } from '../rate-limit/client-identity.service.js';
import { ThrottleGuard } from './throttle.guard.js';
import type { FixedWindowPolicyService } from '../rate-limit/fixed-window-policy.service.js';

describe('ThrottleGuard', () => {
  it('uses the canonical identity service address and current database policy', async () => {
    const incrWithExpire = vi.fn().mockResolvedValue(1);
    const guard = new ThrottleGuard(
      { incrWithExpire } as unknown as KvStoreService,
      {
        getAllAndOverride: vi.fn().mockReturnValue('admin.login'),
      } as unknown as Reflector,
      {
        fromRequest: vi.fn().mockReturnValue({
          family: 'ipv4',
          address: '192.0.2.7',
          exactSubject: 'ip4:192.0.2.7',
        }),
      } as unknown as ClientIdentityService,
      {
        get: vi.fn().mockReturnValue({
          policy: 'admin.login',
          limit: 5,
          windowSeconds: 60,
        }),
        bucketKey: vi
          .fn()
          .mockReturnValue('rl:0:admin.login:192.0.2.7'),
      } as unknown as FixedWindowPolicyService,
    );
    const request = {
      ip: '198.51.100.99',
      url: '/api/v1/login?ignored=true',
    };
    const context = {
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(incrWithExpire).toHaveBeenCalledWith(
      'rl:0:admin.login:192.0.2.7',
      60,
    );
  });
});
