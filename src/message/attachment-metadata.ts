import type { StoredMediaMetadata } from '../upload/stored-media-metadata.js';
import { isStoredMediaMetadata } from '../upload/stored-media-metadata.js';

/** Response-only hydration; never write local derivatives into canonical message content. */
export function hydrateAttachmentMetadata(
  content: string,
  assets: ReadonlyMap<
    string,
    { meta: StoredMediaMetadata | null; bytes: bigint }
  >,
): string {
  const parsed: unknown = JSON.parse(content);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const item = value as Record<string, unknown>;
    if (typeof item.url === 'string') {
      const match =
        /^\/uploads\/msg-assets\/[a-f0-9]{2}\/[a-f0-9]{2}\/([a-f0-9]{64})$/.exec(
          item.url,
        );
      const asset = match ? assets.get(match[1]) : undefined;
      if (asset && isStoredMediaMetadata(asset.meta)) {
        const { mimeType, ...meta } = asset.meta;
        item.digest = match![1];
        item.size = Number(asset.bytes);
        item.mimeType = mimeType;
        item.meta = meta;
      }
    }
    // Only attachment arrays, not quotes or publisher metadata.
    if (Array.isArray(item.items)) item.items.forEach(visit);
  };
  visit(parsed);
  return JSON.stringify(parsed);
}
