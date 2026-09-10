import type { WebdbStorage } from './webdb-storage';

/** Cached bytes only: safe in both a page and a Service Worker, with no network or object URL lifetime. */
export async function cachedAvatarDataUrl(
  storage: Pick<WebdbStorage, 'getAvatar'>,
  identity: string,
  path: string,
): Promise<string | undefined> {
  if (!path) return undefined;
  if (path.startsWith('data:')) return path;
  try {
    const record = await storage.getAvatar(identity);
    if (!record || record.path !== path) return undefined;
    const bytes = new Uint8Array(await record.blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return `data:${record.blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
  } catch {
    return undefined;
  }
}
