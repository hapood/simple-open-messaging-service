import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishContentAddressedFile,
  saveContentAddressedBuffer,
} from './cas-storage.js';

describe('atomic CAS publication', () => {
  let root: string;
  let source: string;
  let target: string;
  let temporary: string;
  const bytes = Buffer.from('complete original bytes');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cas-publication-'));
    source = join(root, 'source.part');
    target = join(
      root,
      'shard',
      createHash('sha256').update(bytes).digest('hex'),
    );
    temporary = join(root, 'tmp');
    await writeFile(source, bytes);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('publishes complete bytes and preserves the authoritative source', async () => {
    expect(await publishContentAddressedFile(source, target, temporary)).toBe(
      'landed',
    );
    expect(await readFile(source)).toEqual(bytes);
    expect(await readFile(target)).toEqual(bytes);
    expect(await readdir(temporary)).toEqual([]);
  });

  it('warns on duplicate publication without replacing the existing inode', async () => {
    await publishContentAddressedFile(source, target, temporary);
    const before = await stat(target);
    expect(await publishContentAddressedFile(source, target, temporary)).toBe(
      'dedup',
    );
    expect((await stat(target)).ino).toBe(before.ino);
    expect(Logger.prototype.warn).toHaveBeenCalledOnce();
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('allows competing publishers to land exactly one immutable target', async () => {
    const results = await Promise.all([
      publishContentAddressedFile(source, target, temporary),
      publishContentAddressedFile(source, target, temporary),
    ]);
    expect(results.sort()).toEqual(['dedup', 'landed']);
    expect(await readFile(target)).toEqual(bytes);
    expect(await readFile(source)).toEqual(bytes);
    expect(await readdir(temporary)).toEqual([]);
  });

  it.each(['directory', 'symlink', 'wrong-size'])(
    'rejects an existing %s rather than claiming deduplication',
    async (kind) => {
      await mkdir(join(root, 'shard'));
      if (kind === 'directory') await mkdir(target);
      else if (kind === 'symlink') await symlink(source, target);
      else await writeFile(target, 'short');
      await expect(
        publishContentAddressedFile(source, target, temporary),
      ).rejects.toThrow('existing CAS target');
      expect(Logger.prototype.error).toHaveBeenCalledOnce();
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
      expect(await readFile(source)).toEqual(bytes);
      expect(await readdir(temporary)).toHaveLength(1);
    },
  );

  it.each(['directory', 'symlink'])(
    'rejects a %s source before copying or publishing',
    async (kind) => {
      const unsafe = join(root, 'unsafe.part');
      if (kind === 'directory') await mkdir(unsafe);
      else await symlink(source, unsafe);
      await expect(
        publishContentAddressedFile(unsafe, target, temporary),
      ).rejects.toThrow('source is not a regular file');
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(source)).toEqual(bytes);
      expect(Logger.prototype.error).toHaveBeenCalledOnce();
      expect(await readdir(temporary)).toEqual([]);
    },
  );

  it('reports copy failures even when a target already exists', async () => {
    await publishContentAddressedFile(source, target, temporary);
    await expect(
      publishContentAddressedFile(join(root, 'missing'), target, temporary),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(Logger.prototype.error).toHaveBeenCalledOnce();
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
    expect(await readFile(target)).toEqual(bytes);
  });

  it('uses the same publication contract for generated buffers', async () => {
    const digest = await saveContentAddressedBuffer(
      bytes,
      () => target,
      temporary,
    );
    expect(digest).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await readFile(target)).toEqual(bytes);
    expect(await readdir(temporary)).toEqual([]);
  });
});
