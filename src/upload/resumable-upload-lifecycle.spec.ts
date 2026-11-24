import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { tmpdir } from 'node:os';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  lstat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pendingMedia, type uploadSession } from '../database/schema.js';
import { ResumableUploadService } from './resumable-upload.service.js';
import { InvalidUploadMediaError } from './upload.service.js';
import { UploadActivityService } from './upload-activity.service.js';

type Session = typeof uploadSession.$inferSelect;
type Internals = {
  tmpDir: string;
  requireStageForPart: (...args: unknown[]) => Promise<unknown>;
  writeSidecar: (key: string, offset: bigint, digest?: string) => Promise<void>;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe('resumable upload lifecycle (no database)', () => {
  let directory: string;
  let session: Session;
  let service: ResumableUploadService;
  let activity: UploadActivityService;
  let internals: Internals;
  let updates: Array<Partial<Session>>;
  let stageUpdates: unknown[];
  const upload = {
    resolveStagedPart: vi.fn(),
    landStagedPart: vi.fn(),
  };
  const messages = {};
  const quota = { assertCanSend: vi.fn(), assertFileSize: vi.fn() };
  const part = () => join(directory, 'stable-key.part');
  const sidecar = () => join(directory, 'stable-key.resume.json');

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'upload-lifecycle-'));
    session = {
      id: 1n,
      pendingMediaId: 41n,
      messageId: null,
      partId: 'part',
      position: 0,
      partIntent: 'FILE',
      creatorId: 1,
      contentType: 'FILE',
      originalName: 'note.txt',
      mimeType: 'text/plain',
      totalBytes: 8n,
      status: 'PENDING',
      tmpKey: 'stable-key',
      digest: null,
      result: null,
      errorReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      abortedAt: null,
    } as Session;
    updates = [];
    stageUpdates = [];
    const database = {
      db: {
        query: {
          uploadSession: { findFirst: vi.fn(async () => ({ ...session })) },
          pendingMedia: { findFirst: vi.fn(async () => ({ id: 41n })) },
        },
        update: vi.fn((table: unknown) => ({
          set: (values: Partial<Session>) => ({
            where: () => {
              if (table === pendingMedia) {
                stageUpdates.push(values);
                return Object.assign(Promise.resolve(), {
                  returning: async () => [],
                });
              }
              // Mirror the fail guard for terminal rows.
              const applicable =
                values.status !== 'FAILED' ||
                session.status === 'PENDING' ||
                values.errorReason === 'USER_CANCELLED';
              if (applicable) {
                updates.push(values);
                Object.assign(session, values);
              }
              return Object.assign(Promise.resolve(), {
                returning: async () => (applicable ? [{ ...session }] : []),
              });
            },
          }),
        })),
      },
    };
    activity = new UploadActivityService();
    service = new ResumableUploadService(
      database as never,
      upload as never,
      messages as never,
      quota as never,
      activity,
    );
    internals = service as unknown as Internals;
    internals.tmpDir = directory;
    vi.spyOn(internals, 'requireStageForPart').mockResolvedValue({
      id: 41n,
      contentType: 'FILE',
    });
    await writeFile(part(), 'abcd');
    await writeFile(sidecar(), JSON.stringify({ offset: 4 }));
  });

  afterEach(async () => {
    activity.onApplicationShutdown();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['FAILED', 'COMPLETED'] as const)(
    'reports no execution phase for a %s outcome',
    async (status) => {
      session.status = status;
      const view = await service.status(1, '1');
      expect(view.status).toBe(status);
      expect(view).not.toHaveProperty('phase');
      expect(view).not.toHaveProperty('clientMessageId');
    },
  );

  it('cleans crash leftovers when completing an already committed upload', async () => {
    session.status = 'COMPLETED';
    await writeFile(`${sidecar()}.tmp`, 'unfinished metadata');
    await expect(service.complete(1, '1')).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    for (const path of [part(), sidecar(), `${sidecar()}.tmp`]) {
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(updates).toHaveLength(0);
    await expect(service.complete(1, '1')).resolves.toMatchObject({
      status: 'COMPLETED',
    });
  });

  it('logs cleanup failure without changing a committed upload outcome', async () => {
    session.status = 'COMPLETED';
    await unlink(part());
    await mkdir(part());
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    try {
      await expect(service.complete(1, '1')).resolves.toMatchObject({
        status: 'COMPLETED',
      });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('cleanup failure'),
        expect.any(AggregateError),
      );
      expect(session.status).toBe('COMPLETED');
      expect(updates).toHaveLength(0);
      await expect(stat(sidecar())).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(part())).isDirectory()).toBe(true);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('records the final digest under the stable UUID checkpoint without consuming source bytes', async () => {
    await writeFile(part(), 'abcdefgh');
    const digest = 'a'.repeat(64);
    await internals.writeSidecar('stable-key', 8n, digest);
    expect(JSON.parse(await readFile(sidecar(), 'utf8'))).toEqual({
      offset: 8,
      digest,
    });
    expect(await service.status(1, '1')).toMatchObject({ offset: 8 });
    expect(await readFile(part(), 'utf8')).toBe('abcdefgh');
  });

  it('rejects a checkpoint claiming a final digest for an incomplete file', async () => {
    await writeFile(
      sidecar(),
      JSON.stringify({ offset: 4, digest: 'a'.repeat(64) }),
    );
    await expect(
      service.append(1, '1', 'bytes 4-7/8', Buffer.from('efgh')),
    ).rejects.toThrow('invalid resumable upload checkpoint');
    expect(await readFile(part(), 'utf8')).toBe('abcd');
  });

  it('rejects malformed digests before replacing an existing checkpoint', async () => {
    await expect(
      internals.writeSidecar('stable-key', 8n, '../invalid'),
    ).rejects.toThrow('invalid upload checkpoint digest');
    expect(JSON.parse(await readFile(sidecar(), 'utf8'))).toEqual({
      offset: 4,
    });
  });

  it('timestamps new chunk progress but not polling or duplicate chunks', async () => {
    session.updatedAt = new Date('2000-01-01T00:00:00Z');
    await service.append(1, '1', 'bytes 4-5/8', Buffer.from('ef'));
    expect(session.updatedAt.getTime()).toBeGreaterThan(
      new Date('2000-01-01T00:00:00Z').getTime(),
    );
    const updatedAt = session.updatedAt;
    await service.status(1, '1');
    await service.append(1, '1', 'bytes 4-5/8', Buffer.from('ef'));
    expect(session.updatedAt).toBe(updatedAt);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ updatedAt });
  });

  it('uses updatedAt without touching legacy abortedAt on stop, retry, and failure', async () => {
    const legacy = new Date('2000-01-01T00:00:00Z');
    session.abortedAt = legacy;
    await service.stop(1, '1');
    await service.retry(1, '1');
    await unlink(sidecar());
    await expect(
      service.append(1, '1', 'bytes 4-7/8', Buffer.from('efgh')),
    ).rejects.toThrow();
    expect(session.status).toBe('FAILED');
    expect(session.abortedAt).toBe(legacy);
    expect(
      updates.every(
        (update) =>
          !('abortedAt' in update) && update.updatedAt instanceof Date,
      ),
    ).toBe(true);
  });

  it('cancels one file, removes companions and retries from zero', async () => {
    await writeFile(`${sidecar()}.tmp`, 'unfinished checkpoint');
    await expect(service.cancel(1, '1')).resolves.toMatchObject({
      status: 'FAILED',
      errorReason: 'USER_CANCELLED',
    });
    for (const path of [part(), sidecar(), `${sidecar()}.tmp`]) {
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(stageUpdates).toEqual([]);
    await service.stop(1, '1');
    expect(session.errorReason).toBe('USER_CANCELLED');
    await expect(service.cancel(1, '1')).resolves.toMatchObject({
      errorReason: 'USER_CANCELLED',
    });
    session.digest = 'a'.repeat(64);
    session.result = { payload: { size: 8 } };
    await expect(service.retry(1, '1')).resolves.toMatchObject({
      offset: 0,
      status: 'PENDING',
      phase: 'UPLOADING',
    });
    expect(await readFile(part(), 'utf8')).toBe('');
    expect(session.digest).toBeNull();
    expect(session.result).toBeNull();
    expect(JSON.parse(await readFile(sidecar(), 'utf8'))).toEqual({
      offset: 0,
    });
  });

  it('reports cancellation cleanup failure and refuses to overwrite unexpected artifacts', async () => {
    await unlink(part());
    await mkdir(part());
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    try {
      await expect(service.cancel(1, '1')).rejects.toThrow(
        'cancelled upload cleanup failed',
      );
      expect(errorLog).toHaveBeenCalled();
      expect(session.errorReason).toBe('USER_CANCELLED');
      await expect(stat(sidecar())).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(service.retry(1, '1')).rejects.toThrow(
        'cancelled upload cleanup failed',
      );
      await rm(part(), { recursive: true });
      await expect(service.cancel(1, '1')).resolves.toMatchObject({
        errorReason: 'USER_CANCELLED',
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  it('rejects cancellation after message commit without deleting artifacts', async () => {
    session.status = 'COMPLETED';
    session.messageId = 9n;
    await expect(service.cancel(1, '1')).rejects.toThrow(
      'cannot be cancelled',
    );
    expect(await readFile(part(), 'utf8')).toBe('abcd');
    expect(updates).toEqual([]);
  });

  it('stops without deleting the session, stage, or received bytes; init never revives it', async () => {
    expect(await service.stopForAdmin('1')).toMatchObject({
      status: 'FAILED',
      errorReason: 'USER_STOPPED',
      offset: 4,
    });
    expect(await readFile(part(), 'utf8')).toBe('abcd');
    expect(stageUpdates).toEqual([]);
    expect(
      await service.init(1, {
        clientMessageId: 'batch',
        partId: 'part',
        position: 0,
        intent: 'FILE',
        originalName: 'note.txt',
        mimeType: 'text/plain',
        totalBytes: 8,
      }),
    ).toMatchObject({
      status: 'FAILED',
      errorReason: 'USER_STOPPED',
      offset: 4,
    });
    expect(session.tmpKey).toBe('stable-key');
    await expect(
      service.append(1, '1', 'bytes 4-7/8', Buffer.from('efgh')),
    ).rejects.toThrow('explicit retry');
  });

  it.each(['network failure', 'USER_STOPPED'] as const)(
    'explicitly retries %s using the same checkpoint and tmpKey',
    async (reason) => {
      session.status = 'FAILED';
      session.errorReason = reason;
      await writeFile(part(), 'abcdUNCOMMITTED');
      expect(await service.retryForAdmin('1')).toMatchObject({
        status: 'PENDING',
        phase: 'UPLOADING',
        offset: 4,
      });
      expect(session.tmpKey).toBe('stable-key');
      expect(stageUpdates).toEqual([]);
      expect(session.errorReason).toBeNull();
      expect(await readFile(part(), 'utf8')).toBe('abcd');
      expect(updates.every((update) => !('tmpKey' in update))).toBe(true);
      expect(
        await service.append(1, '1', 'bytes 4-7/8', Buffer.from('efgh')),
      ).toMatchObject({ offset: 8 });
      expect(JSON.parse(await readFile(sidecar(), 'utf8'))).toEqual({
        offset: 8,
      });
    },
  );

  it.each(['missing', 'corrupt', 'out-of-bounds', 'negative', 'null'])(
    'never resets a %s checkpoint or truncates its bytes',
    async (kind) => {
      if (kind === 'missing') await unlink(sidecar());
      else
        await writeFile(
          sidecar(),
          {
            corrupt: '{',
            'out-of-bounds': '{"offset":9}',
            negative: '{"offset":-1}',
            null: 'null',
          }[kind]!,
        );
      await expect(
        service.append(1, '1', 'bytes 0-3/8', Buffer.from('xxxx')),
      ).rejects.toThrow();
      expect(session.status).toBe('FAILED');
      expect(await readFile(part(), 'utf8')).toBe('abcd');
      expect(await service.status(1, '1')).toMatchObject({
        offset: null,
        status: 'FAILED',
      });
      await expect(service.retry(1, '1')).rejects.toThrow();
      expect(session.tmpKey).toBe('stable-key');
    },
  );

  it('retries through the persisted stage ID rather than the request identifier', async () => {
    session.status = 'FAILED';
    await service.retry(1, '1');
    expect(internals.requireStageForPart).toHaveBeenCalledWith(1, {
      pendingMediaId: 41n,
      position: 0,
      intent: 'FILE',
    });
  });

  it('rejects retry after detachment without recreating staging or changing bytes', async () => {
    session.status = 'FAILED';
    session.pendingMediaId = null;
    await expect(service.retry(1, '1')).rejects.toThrow(
      'no pending stage',
    );
    expect(internals.requireStageForPart).not.toHaveBeenCalled();
    expect(await readFile(part(), 'utf8')).toBe('abcd');
    expect(updates).toEqual([]);
  });

  it('does not infer a new upload when both existing artifacts are missing', async () => {
    await unlink(part());
    await unlink(sidecar());
    session.status = 'FAILED';
    session.errorReason = 'USER_STOPPED';
    await expect(service.retry(1, '1')).rejects.toThrow();
    expect(session.status).toBe('FAILED');
    expect(session.errorReason).toBe('USER_STOPPED');
    expect(updates).toHaveLength(0);
  });

  it('accepts an explicit zero checkpoint without a version field', async () => {
    await writeFile(part(), '');
    await writeFile(sidecar(), '{"offset":0}');
    expect(
      await service.append(1, '1', 'bytes 0-3/8', Buffer.from('abcd')),
    ).toMatchObject({ offset: 4 });
    expect(JSON.parse(await readFile(sidecar(), 'utf8'))).toEqual({
      offset: 4,
    });
  });

  it.each(['version', 'blockHashes', 'unexpected'])(
    'rejects a checkpoint containing %s without rewriting files',
    async (field) => {
      const checkpoint = JSON.stringify({ offset: 4, [field]: 1 });
      await writeFile(sidecar(), checkpoint);
      await expect(
        service.append(1, '1', 'bytes 4-7/8', Buffer.from('efgh')),
      ).rejects.toThrow('invalid resumable upload checkpoint');
      await expect(service.retry(1, '1')).rejects.toThrow(
        'invalid resumable upload checkpoint',
      );
      expect(await readFile(part(), 'utf8')).toBe('abcd');
      expect(await readFile(sidecar(), 'utf8')).toBe(checkpoint);
    },
  );

  it.each([
    ['part', 'symlink'],
    ['part', 'directory'],
    ['part', 'dangling'],
    ['checkpoint', 'symlink'],
    ['checkpoint', 'directory'],
    ['checkpoint', 'dangling'],
  ] as const)(
    'rejects a %s %s without touching its target',
    async (artifact, kind) => {
      const path = artifact === 'part' ? part() : sidecar();
      const target = join(directory, 'unrelated');
      const bytes = artifact === 'part' ? 'abcdEXTRA' : '{"offset":4}';
      await writeFile(target, bytes);
      await unlink(path);
      if (kind === 'directory') await mkdir(path);
      else
        await symlink(kind === 'dangling' ? `${target}.missing` : target, path);
      await expect(
        service.append(1, '1', 'bytes 4-7/8', Buffer.from('efgh')),
      ).rejects.toThrow('not a regular file');
      await expect(service.retry(1, '1')).rejects.toThrow(
        'not a regular file',
      );
      expect(await readFile(target, 'utf8')).toBe(bytes);
      const entry = await lstat(path);
      expect(
        kind === 'directory' ? entry.isDirectory() : entry.isSymbolicLink(),
      ).toBe(true);
    },
  );

  it('fails a short staging file without deleting or zeroing it', async () => {
    await writeFile(part(), 'ab');
    await expect(
      service.append(1, '1', 'bytes 4-7/8', Buffer.from('efgh')),
    ).rejects.toThrow('shorter than committed offset');
    expect(session.status).toBe('FAILED');
    expect(await readFile(part(), 'utf8')).toBe('ab');
  });

  it('retries fully received bytes by processing immediately, preserving ordinary failures', async () => {
    session.status = 'FAILED';
    await writeFile(part(), 'abcdefgh');
    await writeFile(sidecar(), '{"offset":8}');
    upload.resolveStagedPart.mockRejectedValue(
      new Error('decoder temporarily unavailable'),
    );
    await expect(service.retryForAdmin('1')).rejects.toThrow(
      'decoder temporarily unavailable',
    );
    expect(upload.resolveStagedPart).toHaveBeenCalledOnce();
    expect(session.status).toBe('FAILED');
    expect(await readFile(part(), 'utf8')).toBe('abcdefgh');
    expect(stageUpdates).toEqual([]);
  });

  it('may remove positively invalid final media but retains the FAILED record', async () => {
    await writeFile(part(), 'abcdefgh');
    await writeFile(sidecar(), '{"offset":8}');
    upload.resolveStagedPart.mockRejectedValue(
      new InvalidUploadMediaError('invalid media'),
    );
    await expect(service.complete(1, '1')).rejects.toThrow(
      'invalid media',
    );
    expect(session.status).toBe('FAILED');
    await expect(readFile(part())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stageUpdates).toEqual([]);
  });

  it('explicitly restarts known-invalid media at zero using the durable outcome, not the error text', async () => {
    await writeFile(part(), 'abcdefgh');
    await writeFile(sidecar(), '{"offset":8}');
    upload.resolveStagedPart.mockRejectedValue(
      new InvalidUploadMediaError('invalid media'),
    );
    await expect(service.complete(1, '1')).rejects.toThrow(
      'invalid media',
    );
    expect(session.result).toEqual({
      outcome: 'invalid-media',
      reason: 'invalid media',
    });
    // Retry permission is persisted in the session outcome, not inferred from missing files.
    expect(await service.retry(1, '1')).toMatchObject({
      status: 'PENDING',
      phase: 'UPLOADING',
      offset: 0,
    });
    expect(session.tmpKey).toBe('stable-key');
    expect(session.result).toBeNull();
    expect(stageUpdates).toEqual([]);
    expect(await readFile(part(), 'utf8')).toBe('');
    expect(JSON.parse(await readFile(sidecar(), 'utf8'))).toEqual({
      offset: 0,
    });
  });

  it('retries invalid-media cleanup before creating a fresh checkpoint', async () => {
    session.status = 'FAILED';
    session.result = { outcome: 'invalid-media', reason: 'invalid content' };
    await unlink(part());
    await mkdir(part());
    await expect(service.retry(1, '1')).rejects.toThrow(
      'staging cleanup failed',
    );
    expect((await stat(part())).isDirectory()).toBe(true);
    expect(updates).toEqual([]);
    await expect(stat(sidecar())).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(part(), { recursive: true });
    await expect(service.retry(1, '1')).resolves.toMatchObject({
      offset: 0,
    });
    expect(session.result).toBeNull();
    expect(stageUpdates).toEqual([]);
  });

  it('does not treat an ordinary failure message as permission to recreate missing staging', async () => {
    session.status = 'FAILED';
    session.errorReason = 'invalid media';
    await unlink(part());
    await unlink(sidecar());
    await expect(service.retry(1, '1')).rejects.toThrow();
    expect(updates).toHaveLength(0);
  });

  it.each([false, true])(
    'checks the final checkpoint digest before recovery publication (matches: %s)',
    async (matches) => {
      const digest = 'a'.repeat(64);
      await writeFile(part(), 'abcdefgh');
      const checkpoint = JSON.stringify({ offset: 8, digest });
      await writeFile(sidecar(), checkpoint);
      upload.resolveStagedPart.mockResolvedValue({
        digest: matches ? digest : 'b'.repeat(64),
        payload: { size: 8 },
      });
      const commit = vi
        .spyOn(
          service as unknown as {
            tryCommitBatch: () => Promise<unknown>;
          },
          'tryCommitBatch',
        )
        .mockResolvedValue({ kind: 'not-ready' });
      if (matches) {
        await service.recoverPending(1, '1');
        expect(commit).toHaveBeenCalledOnce();
        expect(session.digest).toBe(digest);
        expect(session.status).toBe('PENDING');
      } else {
        await expect(service.recoverPending(1, '1')).rejects.toThrow(
          'staged upload digest does not match its final checkpoint',
        );
        expect(commit).not.toHaveBeenCalled();
        expect(session.digest).toBeNull();
        expect(session.result).toBeNull();
        expect(session.status).toBe('FAILED');
        expect(await readFile(sidecar(), 'utf8')).toBe(checkpoint);
      }
      expect(await readFile(part(), 'utf8')).toBe('abcdefgh');
      expect(upload.landStagedPart).not.toHaveBeenCalled();
    },
  );

  it('recovers a complete PENDING checkpoint without persisting a processing status', async () => {
    await writeFile(part(), 'abcdefgh');
    await writeFile(sidecar(), '{"offset":8}');
    upload.resolveStagedPart.mockRejectedValue(
      new Error('processing unavailable'),
    );
    await expect(service.recoverPending(1, '1')).rejects.toThrow(
      'processing unavailable',
    );
    expect(upload.resolveStagedPart).toHaveBeenCalledOnce();
    expect(
      updates.every(
        (update) =>
          update.status === undefined ||
          ['PENDING', 'FAILED', 'COMPLETED'].includes(update.status),
      ),
    ).toBe(true);
    expect(session.status).toBe('FAILED');
    expect(await readFile(part(), 'utf8')).toBe('abcdefgh');
  });

  it('does not automatically recover a failed task even with a complete checkpoint', async () => {
    session.status = 'FAILED';
    await writeFile(part(), 'abcdefgh');
    await writeFile(sidecar(), '{"offset":8}');
    await service.recoverPending(1, '1');
    expect(upload.resolveStagedPart).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('expires waiting uploads without deleting bytes or their stage', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await service.recoverWaiting(1, '1');
    await vi.advanceTimersByTimeAsync(30_001);
    expect(session.status).toBe('FAILED');
    expect(session.errorReason).toBe('upload receive timed out');
    expect(await readFile(part(), 'utf8')).toBe('abcd');
    expect(stageUpdates).toEqual([]);
  });

  it('replaces the waiting deadline on explicit stop and retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await service.recoverWaiting(1, '1');
    await vi.advanceTimersByTimeAsync(20_000);
    await service.stop(1, '1');
    await service.retry(1, '1');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(session.status).toBe('PENDING');
    expect(session.errorReason).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.status).toBe('FAILED');
  });

  it('direct append owns a processing phase during IO, then resumes its waiting deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await service.recoverWaiting(1, '1');
    const entered = deferred();
    const release = deferred();
    const write = internals.writeSidecar.bind(internals);
    vi.spyOn(internals, 'writeSidecar').mockImplementationOnce(
      async (key, offset) => {
        entered.resolve();
        await release.promise;
        await write(key, offset);
      },
    );
    const appending = service.append(
      1,
      '1',
      'bytes 4-5/8',
      Buffer.from('ef'),
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.status).toBe('PENDING');
    release.resolve();
    await appending;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(session.status).toBe('PENDING');
    await vi.advanceTimersByTimeAsync(2);
    expect(session.status).toBe('FAILED');
    expect(await readFile(part(), 'utf8')).toBe('abcdef');
  });

  it('rejects premature completion without failing the task or renewing its deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await service.recoverWaiting(1, '1');
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(service.complete(1, '1')).rejects.toThrow(
      'upload is incomplete',
    );
    expect(session.status).toBe('PENDING');
    expect(updates).toEqual([]);
    expect(upload.resolveStagedPart).not.toHaveBeenCalled();
    expect(await readFile(part(), 'utf8')).toBe('abcd');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(session.errorReason).toBe('upload receive timed out');
  });

  it('allows remaining bytes after rejecting premature completion without an explicit retry', async () => {
    await expect(service.complete(1, '1')).rejects.toThrow(
      'upload is incomplete',
    );
    await expect(
      service.append(1, '1', 'bytes 4-7/8', Buffer.from('efgh')),
    ).resolves.toMatchObject({
      status: 'PENDING',
      phase: 'COMPLETING',
      offset: 8,
    });
    expect(session.status).toBe('PENDING');
    expect(await readFile(part(), 'utf8')).toBe('abcdefgh');
  });

  it('suspends receive deadlines after the final durable chunk and rejects new receivers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await service.recoverWaiting(1, '1');
    await service.append(1, '1', 'bytes 4-7/8', Buffer.from('efgh'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.status).toBe('PENDING');
    expect(session.errorReason).toBeNull();
    await expect(service.activityForReceive(1, '1')).rejects.toThrow(
      'upload is not waiting for a chunk',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.status).toBe('PENDING');
  });

  it('does not create a receive deadline for a recovered complete checkpoint', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await writeFile(part(), 'abcdefgh');
    await writeFile(sidecar(), '{"offset":8}');
    await expect(service.activityForReceive(1, '1')).rejects.toThrow(
      'upload is not waiting for a chunk',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.status).toBe('PENDING');
    expect(updates).toEqual([]);
  });

  it('server processing suspends receive idle failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await writeFile(part(), 'abcdefgh');
    await writeFile(sidecar(), '{"offset":8}');
    await service.recoverWaiting(1, '1');
    const entered = deferred();
    const release = deferred();
    upload.resolveStagedPart.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('processing failed');
    });
    const completing = service.complete(1, '1');
    const failed = expect(completing).rejects.toThrow('processing failed');
    await entered.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.status).toBe('PENDING');
    release.resolve();
    await failed;
    expect(session.errorReason).toBe('processing failed');
  });

  it.each(['resolved', 'invalid', 'failed'] as const)(
    'discards a late %s processing outcome after cancellation and drains before cleanup',
    async (outcome) => {
      await writeFile(part(), 'abcdefgh');
      await writeFile(sidecar(), '{"offset":8}');
      const entered = deferred();
      const release = deferred();
      const invalidated = deferred();
      upload.resolveStagedPart.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        if (outcome === 'invalid')
          throw new InvalidUploadMediaError('invalid late result');
        if (outcome === 'failed') throw new Error('late processing failure');
        return { digest: 'a'.repeat(64), payload: { size: 8 } };
      });
      const stop = activity.stop.bind(activity);
      vi.spyOn(activity, 'stop').mockImplementation((handle) => {
        stop(handle);
        invalidated.resolve();
      });
      await service.recoverWaiting(1, '1');
      const completing = service.complete(1, '1');
      const rejected = expect(completing).rejects.toThrow('cancelled');
      await entered.promise;
      const cancelling = service.cancelTemporaryUpload('stable-key');
      await invalidated.promise;
      expect(await readFile(part(), 'utf8')).toBe('abcdefgh');
      await expect(service.retry(1, '1')).rejects.toThrow(
        'execution is busy',
      );
      await expect(service.complete(1, '1')).rejects.toThrow(
        'execution is busy',
      );
      release.resolve();
      await rejected;
      await expect(cancelling).resolves.toBe(true);
      expect(session).toMatchObject({
        status: 'FAILED',
        errorReason: 'USER_CANCELLED',
      });
      expect(session.digest).toBeNull();
      expect(session.result).toBeNull();
      expect(updates.filter((update) => update.status === 'FAILED')).toEqual([
        expect.objectContaining({ errorReason: 'USER_CANCELLED' }),
      ]);
      expect(stageUpdates).toEqual([]);
      expect(upload.landStagedPart).not.toHaveBeenCalled();
      for (const path of [part(), sidecar()])
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('does not resume receiving when cancellation interrupts retry validation', async () => {
    session.status = 'FAILED';
    const entered = deferred();
    const release = deferred();
    const invalidated = deferred();
    quota.assertCanSend.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    // Preserve a transport handle so the test observes the cancellation transition directly.
    session.status = 'PENDING';
    await service.recoverWaiting(1, '1');
    session.status = 'FAILED';
    const stop = activity.stop.bind(activity);
    vi.spyOn(activity, 'stop').mockImplementation((handle) => {
      stop(handle);
      invalidated.resolve();
    });
    const retry = service.retry(1, '1');
    const rejected = expect(retry).rejects.toThrow('cancelled');
    await entered.promise;
    const cancellation = service.cancel(1, '1');
    await invalidated.promise;
    release.resolve();
    await rejected;
    await cancellation;
    expect(updates.some((update) => update.status === 'PENDING')).toBe(false);
    expect(session.errorReason).toBe('USER_CANCELLED');
    await expect(stat(part())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps storage identity but replaces runtime identity on explicit retry', async () => {
    const old = await service.activityForReceive(1, '1');
    await service.stop(1, '1');
    await service.retry(1, '1');
    const current = await service.activityForReceive(1, '1');
    expect(current.task).toEqual(old.task);
    expect(current).not.toBe(old);
    expect(activity.isCurrent(old)).toBe(false);
    expect(activity.isCurrent(current)).toBe(true);
  });

  it('startup observations do not renew the waiting deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    await service.recoverWaiting(1, '1');
    await vi.advanceTimersByTimeAsync(20_000);
    await service.recoverWaiting(1, '1');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(session.status).toBe('FAILED');
  });

  it('rejects retry and writes while stop drains an already-started file operation', async () => {
    const entered = deferred();
    const finish = deferred();
    const originalWrite = internals.writeSidecar.bind(internals);
    vi.spyOn(internals, 'writeSidecar').mockImplementationOnce(
      async (key, offset) => {
        entered.resolve();
        await finish.promise;
        await originalWrite(key, offset);
      },
    );
    const appending = service.append(
      1,
      '1',
      'bytes 4-5/8',
      Buffer.from('ef'),
    );
    const interrupted = expect(appending).rejects.toThrow('cancelled');
    await entered.promise;
    const stopping = service.stopForAdmin('1');
    await expect(service.retry(1, '1')).rejects.toThrow(
      'execution is busy',
    );
    await expect(
      service.append(1, '1', 'bytes 6-7/8', Buffer.from('gh')),
    ).rejects.toThrow('execution is busy');
    finish.resolve();
    await interrupted;
    expect(await stopping).toMatchObject({
      status: 'FAILED',
      errorReason: 'USER_STOPPED',
      offset: 6,
    });
    expect(await service.retry(1, '1')).toMatchObject({
      status: 'PENDING',
      phase: 'UPLOADING',
      offset: 6,
    });
    expect(await readFile(part(), 'utf8')).toBe('abcdef');
  });
});
