import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TemporaryGarbageService } from './temporary-garbage.service.js';

const tmpKey = '00000000-0000-4000-8000-000000000001';
const digest = 'a'.repeat(64);
let root: string;
let tasks: { id: string; status: string }[];
let busy: boolean;
let subject: TemporaryGarbageService;
let execute: ReturnType<typeof vi.fn>;
let cancelUpload: ReturnType<typeof vi.fn>;
let casLock: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'garbage-test-'));
  vi.stubEnv('SOMS_DATA_DIR', root);
  await mkdir(join(root, 'resumable'));
  await mkdir(join(root, 'cas/tmp'), { recursive: true });
  tasks = [];
  busy = false;
  execute = vi.fn(async () => ({ rows: tasks }));
  const db = {
    execute,
    transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({ execute }),
  };
  cancelUpload = vi.fn().mockResolvedValue(false);
  casLock = vi.fn(async (_key, operation) => operation());
  subject = new TemporaryGarbageService(
    { db } as never,
    { casTmpDir: join(root, 'cas/tmp'), withCasDigestLock: casLock } as never,
    { cancelTemporaryUpload: cancelUpload } as never,
    { hasDigest: () => busy } as never,
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const put = (directory: string, name: string, content = 'data') =>
  writeFile(join(root, directory, name), content);

describe('explicit temporary garbage cleanup', () => {
  it('groups every known companion, leaves unknown files separate and preserves task records', async () => {
    for (const suffix of ['.part', '.resume.json', '.resume.json.tmp'])
      await put('resumable', tmpKey + suffix);
    for (const suffix of [
      '.part',
      '.resume.json',
      '.resume.json.tmp',
      '.complete',
      '.complete.tmp',
    ])
      await put('cas/tmp', digest + suffix);
    await put('resumable', 'unknown.tmp');
    tasks = [
      { id: 'task', status: 'FAILED' },
      { id: 'other', status: 'FAILED' },
    ];
    const result = await subject.scan();
    expect(result.list).toHaveLength(3);
    expect(
      result.list.find((entry) => entry.kind === 'upload')?.files,
    ).toHaveLength(3);
    expect(
      result.list.find((entry) => entry.kind === 'download')?.files,
    ).toHaveLength(5);
    const upload = result.list.find((entry) => entry.kind === 'upload')!;
    cancelUpload.mockImplementationOnce(async () => {
      for (const suffix of ['.part', '.resume.json', '.resume.json.tmp'])
        await rm(join(root, 'resumable', tmpKey + suffix));
      return true;
    });
    await subject.clean(upload.token);
    expect(cancelUpload).toHaveBeenCalledWith(tmpKey);
    expect(await readdir(join(root, 'resumable'))).toEqual(['unknown.tmp']);
    expect(tasks).toEqual([
      { id: 'task', status: 'FAILED' },
      { id: 'other', status: 'FAILED' },
    ]);
    // Only SELECT and LOCK are issued by cleanup; no task UPDATE/DELETE is available in the fixture.
    expect(execute).toHaveBeenCalled();
  });

  it('uses group maximum mtime and inspects all entries before selecting the oldest 20', async () => {
    for (let index = 0; index < 25; index++) {
      const name = `entry-${String(index).padStart(2, '0')}`;
      await put('resumable', name);
      await utimes(join(root, 'resumable', name), 100 + index, 100 + index);
    }
    await put('resumable', tmpKey + '.part');
    await put('resumable', tmpKey + '.resume.json');
    await utimes(join(root, 'resumable', tmpKey + '.part'), 1, 1);
    await utimes(join(root, 'resumable', tmpKey + '.resume.json'), 1000, 1000);
    const result = await subject.scan();
    expect(result.total).toBe(26);
    expect(result.list).toHaveLength(20);
    expect(result.list[0].name).toBe('entry-00');
    expect(result.list[19].name).toBe('entry-19');
  });

  it.each(['PENDING', 'COMPLETED'])(
    'excludes pending or completed shared owners with state %s',
    async (status) => {
      await put('cas/tmp', digest + '.part');
      tasks = [
        { id: 'stopped', status: 'FAILED' },
        { id: 'consumer', status },
      ];
      expect((await subject.scan()).list).toEqual([]);
    },
  );

  it('revalidates ownership inside the digest lock and refuses a retry after scan', async () => {
    await put('cas/tmp', digest + '.part');
    const entry = (await subject.scan()).list[0];
    casLock.mockImplementation(async (_key, operation) => {
      tasks = [{ id: 'restarted', status: 'PENDING' }];
      return operation();
    });
    await expect(subject.clean(entry.token)).rejects.toThrow(
      'active or completed owner',
    );
    expect(
      await readFile(join(root, 'cas/tmp', digest + '.part'), 'utf8'),
    ).toBe('data');
  });

  it('excludes physical consumers even without durable rows', async () => {
    await put('cas/tmp', digest + '.part');
    busy = true;
    expect((await subject.scan()).list).toEqual([]);
  });

  it('locks buffer publication leftovers by digest without merging them into download groups', async () => {
    const name = `${digest}.123.0123456789ab.tmp`;
    await put('cas/tmp', name);
    const entry = (await subject.scan()).list[0];
    expect(entry.kind).toBe('unknown');
    await subject.clean(entry.token);
    expect(casLock).toHaveBeenCalledWith(digest, expect.any(Function));
  });

  it('rejects stale snapshots, newly added companions and arbitrary paths', async () => {
    await put('resumable', tmpKey + '.part');
    const entry = (await subject.scan()).list[0];
    await put('resumable', tmpKey + '.resume.json');
    await expect(subject.clean(entry.token)).rejects.toThrow('changed');
    await expect(subject.clean('../../etc/passwd')).rejects.toThrow('expired');
    expect(await readdir(join(root, 'resumable'))).toHaveLength(2);
  });

  it('orders an unexpected directory by its own mtime rather than descendant activity', async () => {
    await mkdir(join(root, 'resumable/unexpected'));
    await put('resumable/unexpected', 'recent');
    await put('resumable', 'older-file');
    await utimes(join(root, 'resumable/unexpected/recent'), 1000, 1000);
    await utimes(join(root, 'resumable/unexpected'), 10, 10);
    await utimes(join(root, 'resumable/older-file'), 20, 20);
    const result = await subject.scan();
    expect(result.list.map((entry) => entry.name)).toEqual([
      'unexpected',
      'older-file',
    ]);
    expect(result.list[0].modifiedAt).toBe(new Date(10_000).toISOString());
  });

  it('lists deep directories without traversing them and bounds confirmed deletion inspection', async () => {
    const deep = join(
      root,
      'resumable',
      ...Array.from({ length: 35 }, () => 'nested'),
    );
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'kept'), 'data');
    const result = await subject.scan();
    expect(result.list).toHaveLength(1);
    expect(result.list[0]).toMatchObject({
      name: 'nested',
      bytes: null,
      canDelete: true,
    });
    await expect(subject.clean(result.list[0].token, true)).rejects.toThrow(
      'safe inspection limits',
    );
    expect(await readFile(join(deep, 'kept'), 'utf8')).toBe('data');
  });

  it('shows an unexpected directory once and requires explicit recursion confirmation', async () => {
    await mkdir(join(root, 'resumable/unexpected/nested'), { recursive: true });
    await put('resumable/unexpected/nested', 'data');
    const result = await subject.scan();
    expect(result.list).toHaveLength(1);
    expect(result.list[0]).toMatchObject({
      kind: 'directory',
      files: ['unexpected'],
      bytes: null,
    });
    await expect(subject.clean(result.list[0].token)).rejects.toThrow(
      'confirmation',
    );
    await subject.clean(result.list[0].token, true);
    expect(await readdir(join(root, 'resumable'))).toEqual([]);
  });

  it('does not follow symbolic links, including nested links and root replacements', async () => {
    await put('', 'outside');
    await mkdir(join(root, 'resumable/directory'));
    await put('resumable/directory', 'before-link');
    await symlink(
      join(root, 'outside'),
      join(root, 'resumable/directory/link'),
    );
    await symlink(join(root, 'outside'), join(root, 'resumable/link'));
    const result = await subject.scan();
    expect(result.list).toHaveLength(2);
    expect(result.list.find((entry) => entry.name === 'link')?.canDelete).toBe(
      false,
    );
    // A shallow scan cannot classify descendants; confirmed deletion checks them.
    expect(
      result.list.find((entry) => entry.name === 'directory')?.canDelete,
    ).toBe(true);
    for (const entry of result.list)
      await expect(subject.clean(entry.token, true)).rejects.toThrow(
        'unsupported',
      );
    expect(await readFile(join(root, 'outside'), 'utf8')).toBe('data');
    expect(
      await readFile(join(root, 'resumable/directory/before-link'), 'utf8'),
    ).toBe('data');
    await rm(join(root, 'resumable'), { recursive: true });
    await symlink(join(root, 'cas/tmp'), join(root, 'resumable'));
    await expect(subject.scan()).rejects.toThrow('safe physical directory');
  });

  it('deletes active uploads through cancellation without unlinking files recreated by retry', async () => {
    await put('resumable', tmpKey + '.part');
    tasks = [{ id: 'upload', status: 'PENDING' }];
    const entry = (await subject.scan()).list[0];
    expect(entry.canDelete).toBe(true);
    cancelUpload.mockImplementationOnce(async () => {
      await put('resumable', tmpKey + '.part', 'fresh retry');
      return true;
    });
    execute.mockClear();
    await subject.clean(entry.token);
    expect(cancelUpload).toHaveBeenCalledWith(tmpKey);
    expect(execute).not.toHaveBeenCalled();
    expect(
      await readFile(join(root, 'resumable', tmpKey + '.part'), 'utf8'),
    ).toBe('fresh retry');
  });

  it('reports cancellation cleanup failures and permits explicit retry of the delete command', async () => {
    await put('resumable', tmpKey + '.part');
    tasks = [{ id: 'upload', status: 'FAILED' }];
    const entry = (await subject.scan()).list[0];
    const failure = new Error('unlink failed');
    cancelUpload.mockRejectedValueOnce(failure).mockResolvedValueOnce(true);
    await expect(subject.clean(entry.token)).rejects.toBe(failure);
    await expect(subject.clean(entry.token)).resolves.toEqual({
      cleaned: true,
    });
    expect(cancelUpload).toHaveBeenCalledTimes(2);
  });
});
