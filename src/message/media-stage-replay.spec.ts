import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import { ContentType } from '../database/enums.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import { ThreadPreviewService } from './thread-preview.service.js';
import { MessageService } from './message.service.js';

async function fixture(existing: boolean) {
  const stage = {
    id: 41n,
    direction: 'OUTBOUND',
    messageId: null,
    threadId: 2,
    creatorAccount: 'alice',
    publisherNamespaceId: 0,
    contentType: 'FILE',
    content: '{"_quoteTargetSeq":7}',
    fileCnt: 1,
    status: 'pending',
    originDomain: null,
    expectedAuthorizationEpoch: null,
  };
  const update = vi.fn();
  const insert = vi.fn();
  const values = vi.fn(async () => {});
  insert.mockReturnValue({ values });
  const tx = { insert };
  const module = await Test.createTestingModule({
    providers: [
      MessageService,
      { provide: EventEmitter2, useValue: new EventEmitter2() },
      {
        provide: DatabaseService,
        useValue: {
          db: {
            query: {
              account: {
                findFirst: async () => ({ account: 'alice', namespaceId: 0 }),
              },
              message: { findFirst: async () => undefined },
              pendingMedia: {
                findFirst: async () => (existing ? stage : undefined),
              },
            },
            update,
            transaction: async (
              work: (transaction: typeof tx) => Promise<void>,
            ) => work(tx),
          },
        },
      },
      { provide: LinkPreviewService, useValue: {} },
      { provide: ThreadPreviewService, useValue: {} },
    ],
  }).compile();
  onTestFinished(() => module.close());
  return { service: module.get(MessageService), update, insert, values, stage };
}

describe('media stage admission without retry flags', () => {
  it('reuses an existing stage without resetting state or rewriting its quote', async () => {
    const s = await fixture(true);
    await expect(
      s.service.stageMedia(1, 2, ContentType.FILE, 'client-key', 1, 9),
    ).resolves.toEqual({ clientMessageId: 'client-key' });
    expect(s.update).not.toHaveBeenCalled();
    expect(s.insert).not.toHaveBeenCalled();
    expect(s.stage.content).toBe('{"_quoteTargetSeq":7}');
  });

  it('keeps quoteTargetSeq in the new argument position when creating a stage', async () => {
    const s = await fixture(false);
    await s.service.stageMedia(1, 2, ContentType.FILE, 'client-key', 1, 9);
    expect(s.values).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMessageId: 'client-key',
        content: '{"_quoteTargetSeq":9}',
        fileCnt: 1,
      }),
    );
    expect(s.update).not.toHaveBeenCalled();
  });
});
