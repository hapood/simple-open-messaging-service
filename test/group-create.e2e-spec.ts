import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseService } from '../src/database/database.service.js';
import { relationshipPair } from '../src/database/schema.js';
import { seedUserWithSession } from './seed.js';

describe('group creation authorization', () => {
  let app: INestApplication;
  let database: DatabaseService;

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = fixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
  });

  afterAll(async () => app.close());

  it('lets the owner send immediately after creating a group', async () => {
    const owner = await seedUserWithSession(app, 'group-owner');
    const authorization = `Bearer ${owner.token}`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', authorization)
      .send({ name: 'New group' });
    expect(created.body.code, JSON.stringify(created.body)).toBe(
      BusinessCode.OK,
    );

    const sent = await request(app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', authorization)
      .send({
        threadId: created.body.data.threadId,
        contentType: 'PURE_TEXT',
        content: 'owner message',
      });
    expect(sent.body.code, JSON.stringify(sent.body)).toBe(BusinessCode.OK);
  });

  it('uses the active group relationship as send authority', async () => {
    const owner = await seedUserWithSession(app, 'group-pair-authority');
    const authorization = `Bearer ${owner.token}`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/group/create')
      .set('Authorization', authorization)
      .send({ name: 'Projection lag group' });
    expect(created.body.code, JSON.stringify(created.body)).toBe(
      BusinessCode.OK,
    );
    const threadId = created.body.data.threadId as number;

    const whileActive = await request(app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', authorization)
      .send({
        threadId,
        contentType: 'PURE_TEXT',
        content: 'pair remains authoritative',
      });
    expect(whileActive.body.code, JSON.stringify(whileActive.body)).toBe(
      BusinessCode.OK,
    );

    await database.db
      .update(relationshipPair)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(relationshipPair.threadId, threadId));
    const whileInactive = await request(app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', authorization)
      .send({
        threadId,
        contentType: 'PURE_TEXT',
        content: 'must be rejected',
      });
    expect(whileInactive.body.code).toBe(BusinessCode.GROUP_FORBIDDEN);
  });
});
