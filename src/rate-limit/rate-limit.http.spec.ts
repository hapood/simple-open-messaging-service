import {
  Controller,
  HttpCode,
  HttpStatus,
  INestApplication,
  Post,
  UseGuards,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AllExceptionsFilter } from '../common/exception.filter.js';
import { BusinessCode } from '../common/business-code.js';
import {
  AuthPolicyRegistry,
  AUTH_RATE_LIMIT_POLICIES,
} from './auth-policy.registry.js';
import { ClientIdentityService } from './client-identity.service.js';
import { UseRateLimitPolicy } from './rate-limit.decorator.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimitModeService } from './rate-limit-mode.service.js';
import { RateLimitService } from './rate-limit.service.js';

const MANAGED_ENV = [
  'TRUSTED_PROXY_CIDRS',
  'RATE_LIMIT_AUTH_QR_CREATE_MODE',
  'RATE_LIMIT_AUTH_QR_CREATE_IP_RATE_PER_SECOND',
  'RATE_LIMIT_AUTH_QR_CREATE_IP_BURST',
  'RATE_LIMIT_AUTH_QR_CREATE_IPV6_PREFIX_RATE_PER_SECOND',
  'RATE_LIMIT_AUTH_QR_CREATE_IPV6_PREFIX_BURST',
] as const;
const originalEnv = Object.fromEntries(
  MANAGED_ENV.map((name) => [name, process.env[name]]),
);
const apps: INestApplication[] = [];

@Controller('probe')
class ProbeController {
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseRateLimitPolicy(AUTH_RATE_LIMIT_POLICIES.qrCreate)
  @UseGuards(RateLimitGuard)
  probe(): { ok: true } {
    return { ok: true };
  }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const name of MANAGED_ENV) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('rate-limit HTTP integration', () => {
  it('ignores X-Forwarded-For from an untrusted peer', async () => {
    const app = await createApp('enforce');

    await post(app, '192.0.2.10').expect(HttpStatus.OK);
    const blocked = await post(app, '192.0.2.11').expect(
      HttpStatus.TOO_MANY_REQUESTS,
    );

    expectNewLimiterResponse(blocked);
  });

  it('trusts X-Forwarded-For only through configured loopback proxies and collapses mapped IPv4', async () => {
    const app = await createApp('enforce', true);

    await post(app, '192.0.2.10').expect(HttpStatus.OK);
    const blocked = await post(app, '::ffff:192.0.2.10').expect(
      HttpStatus.TOO_MANY_REQUESTS,
    );

    expectNewLimiterResponse(blocked);
  });

  it('aggregates distinct IPv6 clients in the same /64 prefix', async () => {
    const app = await createApp('enforce', true);

    await post(app, '2001:db8:1234:5678::1').expect(HttpStatus.OK);
    const blocked = await post(app, '2001:db8:1234:5678::2').expect(
      HttpStatus.TOO_MANY_REQUESTS,
    );

    expectNewLimiterResponse(blocked);
  });

  it('observes repeated requests in shadow mode without returning 429', async () => {
    const app = await createApp('shadow', true);

    await post(app, '2001:db8::1').expect(HttpStatus.OK);
    await post(app, '2001:db8::1').expect(HttpStatus.OK);

    expect(app.get(RateLimitService).snapshotStats()).toEqual([
      expect.objectContaining({
        policy: AUTH_RATE_LIMIT_POLICIES.qrCreate,
        mode: 'shadow',
        evaluated: 2,
        wouldBlock: 1,
        blocked: 0,
      }),
    ]);
  });

  it('skips bucket evaluation entirely in disabled mode', async () => {
    const app = await createApp('disabled', true);

    await post(app, '2001:db8::1').expect(HttpStatus.OK);
    await post(app, '2001:db8::1').expect(HttpStatus.OK);

    expect(app.get(RateLimitService).snapshotStats()).toEqual([]);
  });
});

async function createApp(
  mode: 'disabled' | 'shadow' | 'enforce',
  trustLoopback = false,
): Promise<INestApplication> {
  process.env.RATE_LIMIT_AUTH_QR_CREATE_MODE = mode;
  process.env.RATE_LIMIT_AUTH_QR_CREATE_IP_RATE_PER_SECOND = '0.01';
  process.env.RATE_LIMIT_AUTH_QR_CREATE_IP_BURST = '1';
  process.env.RATE_LIMIT_AUTH_QR_CREATE_IPV6_PREFIX_RATE_PER_SECOND = '0.01';
  process.env.RATE_LIMIT_AUTH_QR_CREATE_IPV6_PREFIX_BURST = '1';
  process.env.TRUSTED_PROXY_CIDRS = trustLoopback ? '127.0.0.0/8,::1/128' : '';

  const fixture = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [
      ClientIdentityService,
      RateLimitModeService,
      RateLimitService,
      AuthPolicyRegistry,
      RateLimitGuard,
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile();
  const app = fixture.createNestApplication(new FastifyAdapter());
  apps.push(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function post(app: INestApplication, forwardedFor: string) {
  return request(app.getHttpServer())
    .post('/probe')
    .set('X-Forwarded-For', forwardedFor);
}

function expectNewLimiterResponse(response: request.Response): void {
  expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  expect(response.body).toEqual({
    code: BusinessCode.RATE_LIMITED,
    message: 'too many requests',
    data: { retryAfter: expect.any(Number) },
  });
}
