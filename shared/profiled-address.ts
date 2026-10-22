import type { ProfileKey } from './profile-demand.js';

/** An event participant's immutable identity and profile revision at the event boundary.
 * The display domain is NOT part of this wire contract: it resolves through the
 * profile-namespace binding selected by the publisher/profile namespace pair. */
export interface ProfiledAddress {
  account: string;
  publisherNamespaceId: number;
  profileNamespaceId: number;
  profileRev: number;
}

/** Validates the current four-field address contract. Unknown extra keys are ignored — writers
 * must not emit them, but the reader neither requires nor rejects them. */
export function isProfiledAddress(value: unknown): value is ProfiledAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['account'] === 'string' &&
    candidate['account'].trim().length > 0 &&
    Number.isSafeInteger(candidate['publisherNamespaceId']) &&
    (candidate['publisherNamespaceId'] as number) >= 0 &&
    Number.isSafeInteger(candidate['profileNamespaceId']) &&
    (candidate['profileNamespaceId'] as number) >= 0 &&
    Number.isSafeInteger(candidate['profileRev']) &&
    (candidate['profileRev'] as number) >= 0 &&
    (candidate['account'] !== '$system' ||
      ((candidate['publisherNamespaceId'] as number) === 0 &&
        candidate['profileNamespaceId'] === 0 &&
        candidate['profileRev'] === 0))
  );
}

export function profileKeyForAddress(
  value: ProfiledAddress,
): ProfileKey | undefined {
  if (value.profileRev === 0) return undefined;
  return {
    publisherNamespaceId: value.publisherNamespaceId,
    profileNamespaceId: value.profileNamespaceId,
    account: value.account,
    rev: value.profileRev,
  };
}
