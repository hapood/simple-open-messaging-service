import { constants } from 'node:fs';
import { lstat, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { removeStagingFiles } from './staging-cleanup.js';

/** Sync the source before advancing its checkpoint. The owner must exclude concurrent
 * writers and cleanup for both paths until this operation completes. */
export async function writeCheckpoint(
  path: string,
  content: string,
  sourcePath: string,
): Promise<void> {
  // O_NOFOLLOW rejects links at open time; fstat also rejects directories and devices.
  const source = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await source.stat()).isFile())
      throw new Error(`checkpoint source is not a regular file: ${sourcePath}`);
    await source.sync();
  } finally {
    await source.close();
  }
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing && !existing.isFile())
    throw new Error(`checkpoint is not a regular file: ${path}`);
  const temporary = `${path}.tmp`;
  await removeStagingFiles([temporary]);
  // Never truncate a pre-existing inode or follow a link left at the temporary path.
  const file = await open(temporary, 'wx');
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
