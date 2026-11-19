import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  lstat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { writeCheckpoint } from './write-checkpoint.js';

async function fixture() {
  const root = await mkdtemp('/tmp/opencode/checkpoint-write-');
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'task.part');
  await writeFile(source, 'abcdefgh');
  return { root, source, path: join(root, 'task.resume.json') };
}

describe('checkpoint replacement', () => {
  it('creates and replaces a checkpoint, removing only its stale regular temporary file', async () => {
    const { path, source } = await fixture();
    await writeCheckpoint(path, '{"offset":0}', source);
    await writeFile(`${path}.tmp`, 'unfinished');
    await writeCheckpoint(path, '{"offset":4}', source);
    expect(await readFile(path, 'utf8')).toBe('{"offset":4}');
    await expect(stat(`${path}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['directory', 'symlink', 'dangling'] as const)(
    'refuses a %s temporary path while preserving the checkpoint and unrelated bytes',
    async (kind) => {
      const { root, path, source } = await fixture();
      await writeFile(path, '{"offset":4}');
      const target = join(root, 'unrelated');
      await writeFile(target, 'keep');
      if (kind === 'directory') await mkdir(`${path}.tmp`);
      else
        await symlink(
          kind === 'dangling' ? `${target}.missing` : target,
          `${path}.tmp`,
        );
      await expect(
        writeCheckpoint(path, '{"offset":8}', source),
      ).rejects.toThrow('staging cleanup failed');
      expect(await readFile(path, 'utf8')).toBe('{"offset":4}');
      expect(await readFile(target, 'utf8')).toBe('keep');
      expect(await lstat(`${path}.tmp`)).toBeDefined();
    },
  );

  it.each(['directory', 'symlink', 'dangling'] as const)(
    'refuses a %s checkpoint destination without replacing it',
    async (kind) => {
      const { root, path, source } = await fixture();
      const target = join(root, 'unrelated');
      await writeFile(target, 'keep');
      if (kind === 'directory') await mkdir(path);
      else
        await symlink(kind === 'dangling' ? `${target}.missing` : target, path);
      await expect(
        writeCheckpoint(path, '{"offset":8}', source),
      ).rejects.toThrow('not a regular file');
      expect(await readFile(target, 'utf8')).toBe('keep');
      const entry = await lstat(path);
      expect(
        kind === 'directory' ? entry.isDirectory() : entry.isSymbolicLink(),
      ).toBe(true);
      await expect(stat(`${path}.tmp`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );
});
