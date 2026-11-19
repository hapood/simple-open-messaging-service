import { Test } from '@nestjs/testing';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import { MessageService } from '../message/message.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { ResumableUploadService } from './resumable-upload.service.js';
import { UploadActivityService } from './upload-activity.service.js';
import { UploadService } from './upload.service.js';

async function fixture(
  options: {
    staged?: boolean;
    owner?: number;
    empty?: boolean;
    invalidOutcome?: boolean;
    missingAuthor?: boolean;
  } = {},
) {
  const stage = options.staged
    ? {
        id: 41n,
        direction: 'OUTBOUND',
        messageId: null,
        threadId: 1,
        creatorAccount: 'alice',
        publisherNamespaceId: 0,
        contentType: 'FILE',
        content: '{}',
        originDomain: null,
        expectedAuthorizationEpoch: null,
        status: 'pending',
        fileCnt: 1,
      }
    : undefined;
  const tasks = options.empty
    ? []
    : [
        {
          id: 7n,
          creatorId: options.owner ?? 1,
          pendingMediaId: stage ? 41n : null,
          messageId: stage ? null : 91n,
          status: options.invalidOutcome || stage ? 'FAILED' : 'COMPLETED',
          errorReason: 'USER_CANCELLED',
          digest: null,
          result: null,
        },
      ];
  const predicates: SQL[] = [];
  const messageLookup = vi.fn(async () => ({
    id: 91n,
    creatorAccount: options.missingAuthor ? null : 'alice',
    publisherNamespaceId: 0,
  }));
  const commit = vi.fn();
  const isAuthoredBy = vi.fn(
    async (_author: unknown, userId: number) => userId === 1,
  );
  const module = await Test.createTestingModule({
    providers: [
      ResumableUploadService,
      {
        provide: DatabaseService,
        useValue: {
          db: {
            query: {
              pendingMedia: { findFirst: async () => stage },
              message: { findFirst: messageLookup },
            },
            select: () => ({
              from: () => ({
                where: (predicate: SQL) => {
                  predicates.push(predicate);
                  return Object.assign(Promise.resolve(tasks), {
                    orderBy: async () => tasks,
                  });
                },
              }),
            }),
          },
        },
      },
      {
        provide: MessageService,
        useValue: {
          isAuthoredBy,
          commitOutboundBatch: commit,
        },
      },
      { provide: UploadService, useValue: {} },
      { provide: UserQuotaService, useValue: {} },
      { provide: UploadActivityService, useValue: {} },
    ],
  }).compile();
  onTestFinished(() => module.close());
  return {
    service: module.get(ResumableUploadService),
    predicates,
    messageLookup,
    isAuthoredBy,
    commit,
  };
}

describe('partial-send database task ownership', () => {
  it('selects current tasks by stage ID rather than client identity', async () => {
    const s = await fixture({ staged: true });
    await expect(s.service.sendCompleted(1, 'request')).resolves.toEqual({
      clientMessageId: 'request',
      sent: false,
      completed: 0,
    });
    const query = new PgDialect().sqlToQuery(s.predicates[0]);
    expect(query.sql).toContain('"UploadSession"."pendingMediaId"');
    expect(query.sql).not.toContain('clientMessageId');
    expect(query.params).toEqual([41n]);
    expect(s.messageLookup).not.toHaveBeenCalled();
    expect(s.commit).not.toHaveBeenCalled();
  });

  it('replays only tasks directly owned by the committed message', async () => {
    const s = await fixture();
    await expect(s.service.sendCompleted(1, 'request')).resolves.toEqual({
      clientMessageId: 'request',
      sent: true,
      completed: 1,
    });
    const query = new PgDialect().sqlToQuery(s.predicates[0]);
    expect(query.sql).toContain('"UploadSession"."messageId"');
    expect(query.sql).not.toContain('clientMessageId');
    expect(query.params).toEqual([91n]);
    expect(s.commit).not.toHaveBeenCalled();
  });

  it('checks the committed message author before reading task history', async () => {
    const s = await fixture();
    await expect(s.service.sendCompleted(2, 'request')).rejects.toThrow(
      'upload batch not found',
    );
    expect(s.predicates).toEqual([]);
  });

  it('rejects an authorless message before author lookup or task history reads', async () => {
    const s = await fixture({ missingAuthor: true });
    await expect(s.service.sendCompleted(1, 'request')).rejects.toThrow(
      'upload batch not found',
    );
    expect(s.isAuthoredBy).not.toHaveBeenCalled();
    expect(s.predicates).toEqual([]);
    expect(s.commit).not.toHaveBeenCalled();
  });

  it('rejects mixed owners in a current stage', async () => {
    const s = await fixture({ staged: true, owner: 2 });
    await expect(s.service.sendCompleted(1, 'request')).rejects.toThrow(
      'mixed owners',
    );
    expect(s.commit).not.toHaveBeenCalled();
  });

  it.each([{ owner: 2 }, { invalidOutcome: true }])(
    'rejects inconsistent committed task ownership or outcome: %j',
    async (options) => {
      const s = await fixture(options);
      await expect(s.service.sendCompleted(1, 'request')).rejects.toThrow(
        'ownership or outcome is invalid',
      );
    },
  );

  it('does not treat an unrelated message without upload tasks as a committed batch', async () => {
    const s = await fixture({ empty: true });
    await expect(s.service.sendCompleted(1, 'request')).rejects.toThrow(
      'upload batch not found',
    );
  });
});
