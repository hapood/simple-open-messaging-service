import { Test } from '@nestjs/testing';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, onTestFinished } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import { MessageService } from '../message/message.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { ResumableUploadService } from './resumable-upload.service.js';
import { UploadActivityService } from './upload-activity.service.js';
import { UploadService } from './upload.service.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  let stageId: bigint | null = 41n;
  const deleting = deferred();
  const releaseDelete = deferred();
  const deletedIds: string[] = [];
  const dialect = new PgDialect();
  const module = await Test.createTestingModule({
    providers: [
      ResumableUploadService,
      {
        provide: DatabaseService,
        useValue: {
          db: {
            query: {
              pendingMedia: {
                findFirst: async ({ where }: { where: SQL }) => {
                  const query = dialect.sqlToQuery(where);
                  const byClient = query.sql.includes('"clientMessageId"');
                  const captured = stageId;
                  if (
                    captured === null ||
                    (!byClient && String(query.params[0]) !== String(captured))
                  )
                    return undefined;
                  return {
                    id: captured,
                    direction: 'OUTBOUND',
                    messageId: null,
                    threadId: 1,
                    creatorAccount: 'alice',
                    publisherNamespaceId: 0,
                    contentType: 'FILE',
                    content: '{}',
                    originDomain: null,
                    expectedAuthorizationEpoch: null,
                  };
                },
              },
            },
            select: () => ({ from: () => ({ where: async () => [] }) }),
            transaction: async (work: (tx: object) => Promise<void>) =>
              work({}),
            delete: () => ({
              where: async (predicate: SQL) => {
                const id = String(dialect.sqlToQuery(predicate).params[0]);
                if (id === '41') {
                  deleting.resolve();
                  await releaseDelete.promise;
                }
                deletedIds.push(id);
                if (String(stageId) === id) stageId = null;
              },
            }),
          },
        },
      },
      { provide: MessageService, useValue: { isAuthoredBy: async () => true } },
      { provide: UploadService, useValue: {} },
      { provide: UserQuotaService, useValue: {} },
      { provide: UploadActivityService, useValue: {} },
    ],
  }).compile();
  onTestFinished(() => {
    releaseDelete.resolve();
    return module.close();
  });
  return {
    service: module.get(ResumableUploadService),
    deleting,
    releaseDelete,
    deletedIds,
    replaceStage: () => {
      stageId = 42n;
    },
  };
}

describe('upload stage cancellation transitions', () => {
  it('rejects a conflicting cancellation immediately without redirecting it to a replacement stage', async () => {
    const s = await fixture();
    const first = s.service.cancelBatch(1, 'same-client-key');
    await s.deleting.promise;
    const second = s.service.cancelBatch(1, 'same-client-key');
    await expect(second).rejects.toThrow('execution is busy');
    s.replaceStage();
    s.releaseDelete.resolve();
    await first;
    expect(s.deletedIds).toEqual(['41']);
    await s.service.cancelBatch(1, 'same-client-key');
    expect(s.deletedIds).toEqual(['41', '42']);
  });

  it('uses independent execution states for distinct stage IDs even when the client key is reused', async () => {
    const s = await fixture();
    const first = s.service.cancelBatch(1, 'same-client-key');
    await s.deleting.promise;
    s.replaceStage();
    await s.service.cancelBatch(1, 'same-client-key');
    expect(s.deletedIds).toEqual(['42']);
    s.releaseDelete.resolve();
    await first;
    expect(s.deletedIds).toEqual(['42', '41']);
  });
});
