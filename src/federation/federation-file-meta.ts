export type FederationFileMeta =
  | { kind: 'FILE' }
  | { kind: 'IMAGE'; width: number; height: number }
  | { kind: 'VIDEO'; width: number; height: number; duration: number }
  | { kind: 'AUDIO'; duration: number };

/** Closed wire metadata; no local MIME, thumbnail, or processing fields. */
export function parseFederationFileMeta(value: unknown): FederationFileMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid file meta');
  const meta = value as Record<string, unknown>;
  const fields =
    meta.kind === 'FILE'
      ? ['kind']
      : meta.kind === 'IMAGE'
        ? ['kind', 'width', 'height']
        : meta.kind === 'VIDEO'
          ? ['kind', 'width', 'height', 'duration']
          : meta.kind === 'AUDIO'
            ? ['kind', 'duration']
            : null;
  if (
    !fields ||
    Object.keys(meta).length !== fields.length ||
    fields.some((key) => !(key in meta))
  )
    throw new Error('invalid file meta fields');
  for (const key of ['width', 'height']) {
    if (
      fields.includes(key) &&
      (!Number.isSafeInteger(meta[key]) || Number(meta[key]) <= 0)
    )
      throw new Error('invalid media dimension');
  }
  if (
    fields.includes('duration') &&
    (typeof meta.duration !== 'number' ||
      !Number.isFinite(meta.duration) ||
      meta.duration <= 0)
  )
    throw new Error('invalid media duration');
  return meta as FederationFileMeta;
}
