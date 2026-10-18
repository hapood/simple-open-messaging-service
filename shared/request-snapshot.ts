/** Send-time presentation of a request's receiver. Never identity or authorization evidence. */
export interface RequestSnapshot {
  displayName: string;
  /** A retained image reference, or an explicitly absent avatar. */
  avatar: string | null;
}

/** Decode the closed presentation shape without substituting current profile data. */
export function parseRequestSnapshot(value: unknown): RequestSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid request snapshot');
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 2 ||
    !Object.hasOwn(fields, 'displayName') ||
    !Object.hasOwn(fields, 'avatar') ||
    typeof fields['displayName'] !== 'string' ||
    fields['displayName'].trim().length === 0 ||
    [...fields['displayName']].length > 31 ||
    (fields['avatar'] !== null &&
      (typeof fields['avatar'] !== 'string' ||
        fields['avatar'].trim().length === 0))
  )
    throw new Error('invalid request snapshot');
  return { displayName: fields['displayName'], avatar: fields['avatar'] };
}
