import { lstat, unlink } from 'node:fs/promises';

/**
 * Remove known file artifacts, attempting every path even when another fails.
 * Already absent files are a successful recovery precondition, not an unlink failure.
 * Never recursively remove unexpected directories or follow symlinks.
 * Callers own serialization with writers and logging at their lifecycle boundary.
 */
export async function removeStagingFiles(
  paths: readonly string[],
): Promise<void> {
  const results = await Promise.allSettled(
    paths.map(async (path) => {
      let entry;
      try {
        entry = await lstat(path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new Error(`could not inspect staging artifact ${path}`, {
          cause,
        });
      }
      if (!entry.isFile()) {
        throw new Error(`staging artifact is not a regular file: ${path}`);
      }
      try {
        await unlink(path);
      } catch (cause) {
        throw new Error(`could not remove staging artifact ${path}`, { cause });
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, 'staging cleanup failed');
  }
}
