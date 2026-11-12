export interface MediaThumbnailMetadata {
  digest: string;
  size: number;
  mimeType: 'image/webp';
  width: number;
  height: number;
}

export type StoredMediaMetadata = { mimeType: string } & (
  | { kind: 'FILE' }
  | { kind: 'AUDIO'; duration: number }
  | {
      kind: 'IMAGE';
      width: number;
      height: number;
      thumbnail: MediaThumbnailMetadata;
    }
  | {
      kind: 'VIDEO';
      width: number;
      height: number;
      duration: number;
      thumbnail: MediaThumbnailMetadata;
    }
);

/** Persist only completed results; null and malformed values require processing. */
export function isStoredMediaMetadata(
  value: unknown,
): value is StoredMediaMetadata {
  if (!value || typeof value !== 'object') return false;
  const v = value as StoredMediaMetadata;
  if (
    typeof v.mimeType !== 'string' ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(v.mimeType)
  )
    return false;
  const m = v;
  if (m.kind === 'FILE') return true;
  if (m.kind === 'AUDIO') return Number.isFinite(m.duration) && m.duration > 0;
  if (m.kind !== 'IMAGE' && m.kind !== 'VIDEO') return false;
  if (m.kind === 'VIDEO' && (!Number.isFinite(m.duration) || m.duration <= 0))
    return false;
  const t = m.thumbnail;
  return (
    Number.isSafeInteger(m.width) &&
    m.width > 0 &&
    Number.isSafeInteger(m.height) &&
    m.height > 0 &&
    !!t &&
    /^[a-f0-9]{64}$/.test(t.digest) &&
    t.mimeType === 'image/webp' &&
    Number.isSafeInteger(t.size) &&
    t.size > 0 &&
    Number.isSafeInteger(t.width) &&
    t.width > 0 &&
    Number.isSafeInteger(t.height) &&
    t.height > 0
  );
}
