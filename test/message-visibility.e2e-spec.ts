import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { MessageVisibilityService } from '../src/message/message-visibility.service.js';
import { ForwardBundleService } from '../src/forward/forward-bundle.service.js';
import { withMessageDigest } from './support/message-fixture.js';

describe('message lookup with retained conversation history', () => {
  let mod: TestingModule;
  let visibility: MessageVisibilityService;
  let forwards: ForwardBundleService;
  let viewerId: number;
  let retainedThreadId: number;
  let targetThreadId: number;
  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    const database = mod.get(DatabaseService);
    visibility = new MessageVisibilityService(database);
    forwards = new ForwardBundleService(database, {} as never, visibility);
    const [viewer] = await database.db
      .insert(tables.account)
      .values({
        account: 'visibility-viewer',
        updatedAt: new Date(),
      })
      .returning();
    viewerId = viewer.id;
    const threads = await database.db
      .insert(tables.messageThread)
      .values([
        { type: 'P2P', updatedAt: new Date() },
        { type: 'P2P', updatedAt: new Date() },
      ])
      .returning();
    [retainedThreadId, targetThreadId] = threads.map(({ id }) => id);
    await database.db.insert(tables.accountThreadState).values([
      {
        accountId: viewerId,
        threadId: retainedThreadId,
        messageVisibleThroughSeq: 2,
      },
      { accountId: viewerId, threadId: targetThreadId },
    ]);
    await database.db.insert(tables.message).values([
      {
        threadId: retainedThreadId,
        seq: 1,
        contentType: 'SYSTEM',
        creatorAccount: '$system',
        content: '{}',
        updatedAt: new Date(),
      },
      withMessageDigest({
        threadId: retainedThreadId,
        seq: 2,
        contentType: 'PURE_TEXT',
        content: '{"text":"deleted"}',
        isDeleted: true,
        creatorAccount: 'visibility-viewer',
        updatedAt: new Date(),
      }),
      withMessageDigest({
        threadId: retainedThreadId,
        seq: 3,
        contentType: 'PURE_TEXT',
        content: '{"text":"beyond boundary"}',
        creatorAccount: 'visibility-viewer',
        updatedAt: new Date(),
      }),
      withMessageDigest({
        threadId: targetThreadId,
        seq: 1,
        contentType: 'PURE_TEXT',
        content: '{"text":"intended source"}',
        creatorAccount: 'visibility-viewer',
        updatedAt: new Date(),
      }),
    ]);
  });
  afterAll(async () => {
    await mod?.close();
  });

  it('forwards the exact text source despite a system message in retained history', async () => {
    await expect(
      forwards.prepareDirectMessage(viewerId, {
        threadId: targetThreadId,
        seq: 1,
      }),
    ).resolves.toMatchObject({
      contentType: 'PURE_TEXT',
      content: '{"text":"intended source"}',
    });
  });
  it('does not substitute retained history for a nonexistent sequence', async () => {
    expect(
      await visibility.findVisibleByThreadSeq(viewerId, targetThreadId, 99),
    ).toBeNull();
  });
  it('does not expose deleted messages below the retained-history boundary', async () => {
    expect(
      await visibility.findVisibleByThreadSeq(viewerId, retainedThreadId, 2),
    ).toBeNull();
  });
  it('does not substitute an earlier message for one beyond the boundary', async () => {
    expect(
      await visibility.findVisibleByThreadSeq(viewerId, retainedThreadId, 3),
    ).toBeNull();
  });
  it('retains access to the requested nondeleted message within the boundary', async () => {
    await expect(
      visibility.findVisibleByThreadSeq(viewerId, retainedThreadId, 1),
    ).resolves.toMatchObject({
      threadId: retainedThreadId,
      seq: 1,
      contentType: 'SYSTEM',
    });
  });
});
