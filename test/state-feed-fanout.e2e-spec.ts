import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { clientStateFeed, durableTask } from '../src/database/schema.js';
import {
  ClientStateFeedService,
  type ClientStateFeedWrite,
} from '../src/client-state-feed/client-state-feed.service.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { StateFeedFanoutTaskHandler } from '../src/state-feed/state-feed-fanout-task.handler.js';
import { stateFeedScope } from '../src/state-feed/state-feed-fanout-task.js';
import { seedUserWithSession } from './seed.js';

describe('durable state feed projection', () => {
  let app: TestingModule;
  let database: DatabaseService;
  let clients: ClientStateFeedService;
  let store: DurableTaskStoreService;
  let handler: StateFeedFanoutTaskHandler;
  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = app.get(DatabaseService);
    clients = app.get(ClientStateFeedService);
    store = app.get(DurableTaskStoreService);
    handler = app.get(StateFeedFanoutTaskHandler);
  });
  afterAll(async () => app.close());

  async function fixture(label: string) {
    const user = await seedUserWithSession(
      app as unknown as INestApplication,
      label,
    );
    const write: ClientStateFeedWrite = {
      userId: user.id,
      account: user.account,
      domain: 'local',
      subjectAccount: 'peer',
      subjectDomain: 'local',
      namespaceId: 0,
      eventType: 'RELATIONSHIP_INTENT',
      body: { status: 'REQUESTED' },
    };
    return {
      user,
      write,
      key: stateFeedScope({ target: 'CLIENT', userId: user.id, feedId: '1' }),
    };
  }
  async function pending(key: string) {
    return database.db.query.durableTask.findFirst({
      where: and(
        eq(durableTask.coalescingKey, key),
        eq(durableTask.status, 'PENDING'),
      ),
    });
  }
  async function enqueue(write: ClientStateFeedWrite) {
    return database.db.transaction((tx) => clients.writeInTx(tx, write));
  }

  it('commits state before fanout and merges pending delivery watermarks', async () => {
    const { user, write, key } = await fixture('state-pending');
    const before = await clients.readEndId(user.id);
    expect(await enqueue(write)).toBe(before + 1);
    const first = await pending(key);
    await enqueue({ ...write, body: { status: 'REVOKED' } });
    expect((await pending(key))?.id).toBe(first!.id);
    expect(await clients.readEndId(user.id)).toBe(before + 2);
    const claimed = await store.claim(first!.id);
    await handler.execute(claimed!);
    await store.markSucceeded(first!.id);
    const row = await database.db.query.clientStateFeed.findFirst({
      where: and(
        eq(clientStateFeed.userId, user.id),
        eq(clientStateFeed.eventType, 'RELATIONSHIP_INTENT'),
      ),
    });
    expect(row?.body).toMatchObject({ status: 'REVOKED' });
    expect(await clients.readEndId(user.id)).toBe(before + 2);
    await handler.execute(claimed!);
    expect(await clients.readEndId(user.id)).toBe(before + 2);
  });

  it('lets running fanout yield without rewriting already committed state', async () => {
    const { user, write, key } = await fixture('state-yield');
    const before = await clients.readEndId(user.id);
    await enqueue(write);
    const first = await pending(key);
    const running = await store.claim(first!.id);
    const notify = vi
      .spyOn(clients, 'notifyFeedUpdated')
      .mockImplementation(() => {});
    await enqueue({ ...write, body: { status: 'REVOKED' } });
    const next = await pending(key);
    expect(next!.id).not.toBe(first!.id);
    await handler.execute(running!);
    await store.markSucceeded(first!.id);
    expect(notify).not.toHaveBeenCalled();
    expect(await clients.readEndId(user.id)).toBe(before + 2);
    await handler.execute((await store.claim(next!.id))!);
    await store.markSucceeded(next!.id);
    expect(notify).toHaveBeenCalledWith({
      userId: user.id,
      feedId: before + 2,
    });
    notify.mockRestore();
    expect(await clients.readEndId(user.id)).toBe(before + 2);
  });

  it('rolls pending replacement back with its source transaction', async () => {
    const { write, key } = await fixture('state-rollback');
    await enqueue(write);
    const first = await pending(key);
    await expect(
      database.db.transaction(async (tx) => {
        await clients.writeInTx(tx, { ...write, body: { status: 'REVOKED' } });
        throw new Error('abort source');
      }),
    ).rejects.toThrow('abort source');
    expect((await pending(key))?.payload).toEqual(first!.payload);
  });
});
