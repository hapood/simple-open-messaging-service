import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Publish immutable bytes atomically; the temporary directory must share the target filesystem. */
export async function saveContentAddressedBuffer(
  bytes: Buffer,
  destination: (digest: string) => string,
  temporaryDirectory: string,
): Promise<string> {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const target = destination(digest);
  await mkdir(dirname(target), { recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  const temporary = join(
    temporaryDirectory,
    `${digest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return digest;
}
