import type { ProfileKey } from './profile-demand.js';

/** An event participant's immutable identity and profile revision at the event boundary.
 * The enclosing message supplies the publisher namespace. Revision zero means no disclosed profile.
 * The display domain is NOT part of this wire contract: it resolves through the
 * profile-namespace binding (ProfileNamespaceRepository) by profileNamespaceId. */
export interface ProfiledAddress {
  account: string;
  profileNamespaceId: number;
  profileRev: number;
}

/** Validates the three contract fields. Unknown extra keys are ignored — writers
 * must not emit them, but the reader neither requires nor rejects them. */
export function isProfiledAddress(value: unknown): value is ProfiledAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['account'] === 'string' &&
    candidate['account'].trim().length > 0 &&
    Number.isSafeInteger(candidate['profileNamespaceId']) &&
    (candidate['profileNamespaceId'] as number) >= 0 &&
    Number.isSafeInteger(candidate['profileRev']) &&
    (candidate['profileRev'] as number) >= 0 &&
    (candidate['account'] !== '$system' ||
      (candidate['profileNamespaceId'] === 0 && candidate['profileRev'] === 0))
  );
}

export function profileKeyForAddress(
  value: ProfiledAddress,
  publisherNamespaceId: number,
): ProfileKey | undefined {
  if (value.profileRev === 0) return undefined;
  return {
    publisherNamespaceId,
    profileNamespaceId: value.profileNamespaceId,
    account: value.account,
    rev: value.profileRev,
  };
}
