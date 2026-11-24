import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { tmpdir } from 'node:os';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import { uploadSession, pendingMedia } from '../database/schema.js';
import { MessageService } from '../message/message.service.js';
import { UserQuotaService } from '../quota/user-quota.service.js';
import { ResumableUploadService } from './resumable-upload.service.js';
import { UploadActivityService } from './upload-activity.service.js';
import { UploadService } from './upload.service.js';

async function fixture(
  options: {
    deleteFailure?: boolean;
    previousAttempt?: boolean;
    missingAuthor?: boolean;
    inbound?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'batch-cancel-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const tasks = [1, 2].map((id) => ({
    id: BigInt(id),
    creatorId: 1,
    tmpKey: join(root, `file-${id}`),
    status: 'FAILED',
    errorReason: 'network failure',
    messageId: null,
    pendingMediaId: 41n as bigint | null,
  }));
  const previousTasks = options.previousAttempt
    ? [
        {
          ...tasks[0],
          id: 3n,
          tmpKey: join(root, 'previous'),
          pendingMediaId: null,
        },
      ]
    : [];
  const allTasks = [...tasks, ...previousTasks];
  for (const task of allTasks) {
    await writeFile(`${task.tmpKey}.part`, 'data');
    await writeFile(`${task.tmpKey}.resume.json`, '{"offset":4}');
  }
  let hasStage = true;
  const events: string[] = [];
  const taskQueries: SQL[] = [];
  const tx = {
    update: (table: unknown) => ({
      set: (values: object) => ({
        where: async (predicate: SQL) => {
          expect(table).toBe(uploadSession);
          events.push('cancel-tasks');
          const { params } = new PgDialect().sqlToQuery(predicate);
          for (const task of allTasks) {
            if (params.some((id) => String(id) === String(task.id)))
              Object.assign(task, values);
          }
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        expect(table).toBe(pendingMedia);
        for (const task of tasks) {
          expect(task.errorReason).toBe('USER_CANCELLED');
          for (const suffix of ['.part', '.resume.json', '.resume.json.tmp']) {
            await expect(stat(task.tmpKey + suffix)).rejects.toMatchObject({
              code: 'ENOENT',
            });
          }
        }
        if (options.deleteFailure) throw new Error('database deletion failed');
        events.push('delete-stage');
        hasStage = false;
        for (const task of tasks) task.pendingMediaId = null;
      },
    }),
  };
  const activity = new UploadActivityService();
  const module = await Test.createTestingModule({
    providers: [
      ResumableUploadService,
      {
        provide: DatabaseService,
        useValue: {
          db: {
            delete: tx.delete,
            select: () => ({
              from: () => ({
                where: async (predicate: SQL) => {
                  taskQueries.push(predicate);
                  const { sql, params } = new PgDialect().sqlToQuery(predicate);
                  if (!sql.includes('"pendingMediaId"'))
                    throw new Error(
                      'batch task lookup must use the captured stage ID',
                    );
                  return allTasks.filter(
                    (task) =>
                      task.pendingMediaId !== null &&
                      String(task.pendingMediaId) === String(params[0]),
                  );
                },
              }),
            }),
            query: {
              pendingMedia: {
                findFirst: async () =>
                  hasStage
                    ? {
                        id: 41n,
                        direction: options.inbound ? 'INBOUND' : 'OUTBOUND',
                        messageId: null,
                        threadId: 1,
                        creatorAccount: options.missingAuthor ? null : 'alice',
                        publisherNamespaceId: 0,
                        contentType: 'FILE',
                        content: '{}',
                        originDomain: null,
                        expectedAuthorizationEpoch: null,
                      }
                    : undefined,
              },
            },
            transaction: async (work: (value: typeof tx) => Promise<void>) =>
              work(tx),
          },
        },
      },
      {
        provide: MessageService,
        useValue: {
          isAuthoredBy: async (_author: unknown, id: number) => id === 1,
        },
      },
      { provide: UploadService, useValue: {} },
      { provide: UserQuotaService, useValue: {} },
      { provide: UploadActivityService, useValue: activity },
    ],
  }).compile();
  onTestFinished(() => module.close());
  const service = module.get(ResumableUploadService);
  // Override only path resolution, not the cleanup or cancellation implementation.
  Object.defineProperty(service, 'partPath', {
    value: (key: string) => `${key}.part`,
  });
  Object.defineProperty(service, 'sidecarPath', {
    value: (key: string) => `${key}.resume.json`,
  });
  return {
    service,
    tasks,
    previousTasks,
    events,
    taskQueries,
    hasStage: () => hasStage,
  };
}

describe('explicit upload batch cancellation', () => {
  it('retains cancelled task history and deletes staging only after cleaning every file', async () => {
    const s = await fixture();
    await expect(s.service.cancelBatch(1, 'batch')).resolves.toEqual({
      clientMessageId: 'batch',
      cancelled: 2,
    });
    expect(s.events).toEqual(['cancel-tasks', 'delete-stage']);
    const query = new PgDialect().sqlToQuery(s.taskQueries[0]);
    expect(query.sql).toContain('"UploadSession"."pendingMediaId"');
    expect(query.sql).not.toContain('clientMessageId');
    expect(query.params).toEqual([41n]);
    for (const task of s.tasks) {
      expect(task).toMatchObject({
        status: 'FAILED',
        errorReason: 'USER_CANCELLED',
      });
      for (const suffix of ['.part', '.resume.json'])
        await expect(stat(task.tmpKey + suffix)).rejects.toMatchObject({
          code: 'ENOENT',
        });
    }
    await expect(s.service.cancelBatch(1, 'batch')).rejects.toThrow(
      'upload batch not found',
    );
    expect(s.taskQueries).toHaveLength(2);
  });

  it('cancels only the current stage when a previous attempt used the same client identity', async () => {
    const s = await fixture({ previousAttempt: true });
    await expect(s.service.cancelBatch(1, 'batch')).resolves.toMatchObject({
      cancelled: 2,
    });
    for (const task of s.previousTasks) {
      expect(task.errorReason).toBe('network failure');
      expect(await readFile(`${task.tmpKey}.part`, 'utf8')).toBe('data');
      expect(await readFile(`${task.tmpKey}.resume.json`, 'utf8')).toBe(
        '{"offset":4}',
      );
    }
    expect(s.hasStage()).toBe(false);
    expect(s.tasks.every((task) => task.pendingMediaId === null)).toBe(true);
  });

  it.each([{ missingAuthor: true }, { inbound: true }])(
    'rejects a non-upload stage before task cancellation: %j',
    async (options) => {
      const s = await fixture(options);
      await expect(s.service.cancelBatch(1, 'batch')).rejects.toThrow(
        'upload batch not found',
      );
      expect(s.taskQueries).toEqual([]);
      expect(s.events).toEqual([]);
      expect(s.hasStage()).toBe(true);
      for (const task of s.tasks) {
        expect(task.errorReason).toBe('network failure');
        expect(await readFile(`${task.tmpKey}.part`, 'utf8')).toBe('data');
        expect(await readFile(`${task.tmpKey}.resume.json`, 'utf8')).toBe(
          '{"offset":4}',
        );
      }
    },
  );

  it('rejects mixed task ownership without deleting files or the stage', async () => {
    const s = await fixture();
    s.tasks[1].creatorId = 2;
    await expect(s.service.cancelBatch(1, 'batch')).rejects.toThrow(
      'mixed owners',
    );
    expect(s.events).toEqual([]);
    expect(s.hasStage()).toBe(true);
    for (const task of s.tasks)
      expect(await readFile(`${task.tmpKey}.part`, 'utf8')).toBe('data');
  });

  it('retains staging on cleanup failure and deletes it only after a successful repeat', async () => {
    const s = await fixture();
    const blocked = `${s.tasks[0].tmpKey}.part`;
    await unlink(blocked);
    await mkdir(blocked);
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    onTestFinished(() => log.mockRestore());
    await expect(s.service.cancelBatch(1, 'batch')).rejects.toThrow(
      'cancelled upload cleanup failed',
    );
    expect(log).toHaveBeenCalled();
    expect(s.hasStage()).toBe(true);
    expect(s.events).toEqual(['cancel-tasks']);
    await expect(stat(`${s.tasks[1].tmpKey}.part`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await rm(blocked, { recursive: true });
    await s.service.cancelBatch(1, 'batch');
    expect(s.hasStage()).toBe(false);
    expect(s.events).toEqual(['cancel-tasks', 'cancel-tasks', 'delete-stage']);
  });

  it('can finish database deletion after files were already removed', async () => {
    const options = { deleteFailure: true };
    const s = await fixture(options);
    await expect(s.service.cancelBatch(1, 'batch')).rejects.toThrow(
      'database deletion failed',
    );
    expect(s.hasStage()).toBe(true);
    for (const task of s.tasks) {
      await expect(stat(`${task.tmpKey}.part`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    options.deleteFailure = false;
    await s.service.cancelBatch(1, 'batch');
    expect(s.hasStage()).toBe(false);
  });

  it('does not delete any stage or bytes when the caller is not the owner', async () => {
    const s = await fixture();
    await expect(s.service.cancelBatch(2, 'batch')).rejects.toThrow(
      'not found',
    );
    expect(s.events).toEqual([]);
    for (const task of s.tasks)
      expect(await readFile(`${task.tmpKey}.part`, 'utf8')).toBe('data');
  });
});
