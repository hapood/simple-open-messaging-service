import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { BusinessCode } from '../src/common/business-code';
import { createTestApp } from './support/app';

// Verifies the public liveness probe GET /api/v1/health end-to-end through the Fastify bootstrap: a 200
// envelope carrying the liveness marker, server version, server time, and — the addition under test —
// DB reachability probed by a real SELECT 1 against the (migrated, isolated) test database. The endpoint
// is unauthenticated and does no seeding, and booting AppModule here also exercises the new
// DatabaseService.onModuleInit connect-with-retry path against a live Postgres.

describe('Public liveness probe GET /api/v1/health', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a 200 envelope with status, database=up, version, and time', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(res.body.message).toBe('successful');
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.database).toBe('up');
    expect(typeof res.body.data.version).toBe('string');
    expect(typeof res.body.data.time).toBe('number');
  });
});
