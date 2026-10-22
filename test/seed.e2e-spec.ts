import type { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import {
  accountThreadState,
  messageThread,
  profileTable,
  relationshipIntent,
} from '../src/database/schema.js';
import {
  findP2PRelationship,
  seedAcceptedRelationship,
  seedFederatedPeerNamespace,
  seedUser,
} from './seed.js';

describe('namespace-scoped relationship fixtures', () => {
  let app: INestApplication;
  let database: DatabaseService;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [DatabaseService],
    }).compile();
    app = module.createNestApplication(new FastifyAdapter());
    await app.init();
    database = app.get(DatabaseService);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('seeds local profiles and both accepted directions with their retained revisions, idempotently', async () => {
    const prefix = randomUUID().slice(0, 20);
    const first = await seedUser(app, `${prefix}-first`);
    const second = await seedUser(app, `${prefix}-second`);
    const profile = await database.db.query.profileTable.findFirst({
      where: eq(profileTable.account, first.account),
    });
    expect(profile).toMatchObject({
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 1,
    });
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning();
    for (let attempt = 0; attempt < 2; attempt++)
      await seedAcceptedRelationship(
        database.db,
        first.id,
        second.id,
        thread.id,
      );
    for (const [author, receiver] of [
      [first, second],
      [second, first],
    ]) {
      const facts = await database.db.query.relationshipIntent.findMany({
        where: and(
          eq(relationshipIntent.authorAccount, author.account),
          eq(relationshipIntent.receiverAccount, receiver.account),
        ),
      });
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        authorNamespaceId: 0,
        receiverNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 1,
        status: 'ACCEPTED',
      });
    }
    expect(
      (await findP2PRelationship(database.db, first.id, second.id)).pair
        ?.active,
    ).toBe(true);
    const participants = await database.db.query.accountThreadState.findMany({
      where: eq(accountThreadState.threadId, thread.id),
    });
    expect(participants.map((row) => row.accountId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it('keeps foreign profile revisions unknown and does not create a local participant for a foreign subject', async () => {
    const prefix = randomUUID().slice(0, 20);
    const local = await seedUser(app, `${prefix}-local`);
    const namespaceId = await seedFederatedPeerNamespace(
      database.db,
      `${prefix}.test`,
    );
    const remote = { account: `${prefix}-remote`, namespaceId };
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning();
    await seedAcceptedRelationship(database.db, local.id, remote, thread.id);
    const localFact = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorAccount, local.account),
        eq(relationshipIntent.receiverAccount, remote.account),
      ),
    });
    const remoteFact = await database.db.query.relationshipIntent.findFirst({
      where: and(
        eq(relationshipIntent.authorAccount, remote.account),
        eq(relationshipIntent.receiverAccount, local.account),
      ),
    });
    expect(localFact).toMatchObject({
      authorNamespaceId: 0,
      receiverNamespaceId: namespaceId,
      profileNamespaceId: 0,
      profileRev: 1,
    });
    expect(remoteFact).toMatchObject({
      authorNamespaceId: namespaceId,
      receiverNamespaceId: 0,
      profileNamespaceId: namespaceId,
      profileRev: 0,
    });
    const relationship = await findP2PRelationship(
      database.db,
      local.id,
      remote,
    );
    expect(relationship.pair).toMatchObject({
      active: true,
      endpointANamespaceId: 0,
      endpointBNamespaceId: namespaceId,
    });
    const participants = await database.db.query.accountThreadState.findMany({
      where: eq(accountThreadState.threadId, thread.id),
    });
    expect(participants.map((row) => row.accountId)).toEqual([local.id]);
    await expect(
      findP2PRelationship(database.db, local.id, local.id),
    ).rejects.toThrow('relationship endpoints must differ');
  });
});
