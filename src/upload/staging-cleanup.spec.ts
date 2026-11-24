import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeStagingFiles } from './staging-cleanup.js';

describe('staging cleanup', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'staging-cleanup-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes all companions and permits repeating completed cleanup', async () => {
    const files = ['part', 'resume.json', 'resume.json.tmp'].map((name) =>
      join(root, name),
    );
    for (const path of files) await writeFile(path, 'temporary');
    await removeStagingFiles(files);
    for (const path of files)
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removeStagingFiles(files)).resolves.toBeUndefined();
  });

  it('reports every invalid artifact while still removing regular companions', async () => {
    const part = join(root, 'part');
    const checkpoint = join(root, 'resume.json');
    const temporary = join(root, 'resume.json.tmp');
    await mkdir(part);
    await mkdir(temporary);
    await writeFile(checkpoint, 'checkpoint');
    const error = await removeStagingFiles([part, checkpoint, temporary]).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    await expect(stat(checkpoint)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(part)).isDirectory()).toBe(true);
  });

  it('rejects symlinks and does not remove their target', async () => {
    const target = join(root, 'original');
    const link = join(root, 'part');
    await writeFile(target, 'original');
    await symlink(target, link);
    await expect(removeStagingFiles([link])).rejects.toThrow(
      'staging cleanup failed',
    );
    expect(await readFile(target, 'utf8')).toBe('original');
  });
});
