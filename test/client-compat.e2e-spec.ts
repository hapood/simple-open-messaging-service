import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { BusinessCode } from '../src/common/business-code';
import { CLIENT_API_VERSION } from '../src/common/client-api-version';
import { createTestApp } from './support/app';

describe('GET /api/v1/client/compat', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns pre-login client configuration without a session', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/client/compat');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(BusinessCode.OK);
    expect(res.body.data.apiVersion).toBe(CLIENT_API_VERSION);
    expect(typeof res.body.data.serverVersion).toBe('string');
    expect(res.body.data).toHaveProperty('firebaseConfig');
    expect(res.body.data).not.toHaveProperty('webVersion');
    expect(res.body.data).not.toHaveProperty('sha256');
  });

  it('does not expose the old shell routes', async () => {
    for (const path of ['compat', 'web-manifest', 'web-bundle']) {
      const res = await request(app.getHttpServer()).get(
        `/api/v1/shell/${path}`,
      );
      expect(res.status).toBe(404);
    }
  });

  it('rate-limits the unauthenticated endpoint', async () => {
    let last;
    for (let i = 0; i < 40; i++) {
      last = await request(app.getHttpServer()).get('/api/v1/client/compat');
    }
    expect(last?.status).toBe(429);
    expect(last?.body.code).toBe(BusinessCode.RATE_LIMITED);
  });
});
