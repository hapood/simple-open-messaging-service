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

async function fixture(pendingMediaId: bigint | null = 41n, siblingOwner = 1) {
  // A pending task with a saved result is ready for the batch barrier.
  const task = {
    id: 7n,
    creatorId: 1,
    pendingMediaId,
    messageId: null,
    status: 'PENDING',
    digest: 'a'.repeat(64),
    result: { payload: { size: 8 } },
    totalBytes: 8n,
    tmpKey: 'missing-checkpoint',
  };
  const stage = {
    id: 41n,
    direction: 'OUTBOUND',
    messageId: null,
    threadId: 1,
    creatorAccount: 'alice',
    contentType: 'FILE',
    content: '{}',
    originDomain: null,
    expectedAuthorizationEpoch: null,
    status: 'pending',
    fileCnt: 2,
  };
  const stageLookup = vi.fn(async (_query: { where: SQL }) => stage);
  const siblingQuery = vi.fn((_predicate: SQL) => ({
    orderBy: async () => [{ ...task, creatorId: siblingOwner }],
  }));
  const commit = vi.fn();
  const module = await Test.createTestingModule({
    providers: [
      ResumableUploadService,
      {
        provide: DatabaseService,
        useValue: {
          db: {
            query: {
              uploadSession: { findFirst: async () => task },
              pendingMedia: { findFirst: stageLookup },
            },
            select: () => ({ from: () => ({ where: siblingQuery }) }),
            update: () => ({
              set: () => ({ where: () => ({ returning: async () => [] }) }),
            }),
          },
        },
      },
      { provide: MessageService, useValue: { commitOutboundBatch: commit } },
      { provide: UploadService, useValue: {} },
      { provide: UserQuotaService, useValue: {} },
      { provide: UploadActivityService, useValue: {} },
    ],
  }).compile();
  onTestFinished(() => module.close());
  return {
    service: module.get(ResumableUploadService),
    stageLookup,
    siblingQuery,
    commit,
  };
}

describe('upload batch database identity', () => {
  it('waits for sibling tasks grouped by stage ID, not by client request ID', async () => {
    const s = await fixture();
    await expect(s.service.complete(1, '1')).resolves.toMatchObject({
      status: 'PENDING',
      phase: 'COMPLETING',
    });
    const dialect = new PgDialect();
    const stage = dialect.sqlToQuery(s.stageLookup.mock.calls[0][0].where);
    const siblings = dialect.sqlToQuery(s.siblingQuery.mock.calls[0][0]);
    expect(stage.sql).toContain('"PendingMedia"."id"');
    expect(siblings.sql).toContain('"UploadSession"."pendingMediaId"');
    expect(stage.params).toEqual([41n]);
    expect(siblings.params).toEqual([41n]);
    expect(stage.sql + siblings.sql).not.toContain('clientMessageId');
    expect(s.commit).not.toHaveBeenCalled();
  });

  it('rejects another owner in the stage instead of committing a mixed batch', async () => {
    const s = await fixture(41n, 2);
    await expect(s.service.complete(1, '1')).rejects.toThrow(
      'another owner',
    );
    expect(s.commit).not.toHaveBeenCalled();
  });

  it('rejects a detached unfinished task without falling back to clientMessageId', async () => {
    const s = await fixture(null);
    await expect(s.service.complete(1, '1')).rejects.toThrow(
      'upload task has no pending stage',
    );
    expect(s.stageLookup).not.toHaveBeenCalled();
    expect(s.siblingQuery).not.toHaveBeenCalled();
    expect(s.commit).not.toHaveBeenCalled();
  });
});
