import { Test } from '@nestjs/testing';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import { MessageService } from '../message/message.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { ResumableUploadService } from './resumable-upload.service.js';
import { UploadService } from './upload.service.js';
import { UploadActivityService } from './upload-activity.service.js';
import { publishContentAddressedFile } from './cas-storage.js';

async function fixture(invalidTarget: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'upload-publication-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.part');
  const target = join(root, 'formal');
  await writeFile(source, 'data');
  if (invalidTarget) await mkdir(target);
  else await writeFile(target, 'data');
  const task = {
    id: 7n,
    creatorId: 1,
    pendingMediaId: 41n,
    messageId: null,
    status: 'PENDING',
    digest: 'a'.repeat(64),
    tmpKey: 'source',
    totalBytes: 4n,
    result: { payload: { size: 4 } },
  };
  const stage = {
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
  };
  const commit = vi.fn(async () => {
    throw new Error('commit boundary reached');
  });
  const exists = vi.fn(() => true);
  const publish = vi.fn(() =>
    publishContentAddressedFile(source, target, join(root, 'tmp')),
  );
  const module = await Test.createTestingModule({
    providers: [
      ResumableUploadService,
      {
        provide: DatabaseService,
        useValue: {
          db: {
            query: {
              uploadSession: { findFirst: async () => task },
              pendingMedia: { findFirst: async () => stage },
            },
            select: () => ({
              from: () => ({ where: () => ({ orderBy: async () => [task] }) }),
            }),
            update: () => ({
              set: () => ({
                where: () =>
                  Object.assign(Promise.resolve(), {
                    returning: async () => [],
                  }),
              }),
            }),
          },
        },
      },
      {
        provide: MessageService,
        useValue: {
          isAuthoredBy: async () => true,
          commitOutboundBatch: commit,
        },
      },
      {
        provide: UploadService,
        useValue: {
          prepareStagedMetadata: async () => ({ kind: 'FILE' }),
          casShardExists: exists,
          landStagedPart: publish,
        },
      },
      { provide: UserQuotaService, useValue: {} },
      { provide: UploadActivityService, useValue: {} },
    ],
  }).compile();
  onTestFinished(() => module.close());
  return {
    service: module.get(ResumableUploadService),
    commit,
    publish,
    exists,
  };
}

describe('upload publication barrier', () => {
  it.each(['complete', 'partial'] as const)(
    '%s rejects an invalid existing target before message commit',
    async (command) => {
      const s = await fixture(true);
      await expect(
        command === 'complete'
          ? s.service.complete(1, '1')
          : s.service.sendCompleted(1, 'request'),
      ).rejects.toThrow('existing CAS target is not a complete regular file');
      expect(s.publish).toHaveBeenCalledOnce();
      expect(s.exists).not.toHaveBeenCalled();
      expect(s.commit).not.toHaveBeenCalled();
    },
  );

  it.each(['complete', 'partial'] as const)(
    '%s validates dedup publication before entering message commit',
    async (command) => {
      const s = await fixture(false);
      await expect(
        command === 'complete'
          ? s.service.complete(1, '1')
          : s.service.sendCompleted(1, 'request'),
      ).rejects.toThrow('commit boundary reached');
      expect(s.publish).toHaveBeenCalledOnce();
      expect(s.exists).not.toHaveBeenCalled();
      expect(s.commit).toHaveBeenCalledOnce();
    },
  );
});
