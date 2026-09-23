import type { ProfileKey } from './profile-selector.js';

/** An event participant's immutable identity and profile revision at the event boundary.
 * Revision zero means no disclosed profile; it never authorizes a profile request. */
export interface ProfiledAddress {
  account: string;
  domain: string;
  namespaceId: number;
  profileRev: number;
}

export function isProfiledAddress(value: unknown): value is ProfiledAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 4 &&
    Object.keys(candidate).every((key) =>
      ['account', 'domain', 'namespaceId', 'profileRev'].includes(key),
    ) &&
    typeof candidate['account'] === 'string' &&
    candidate['account'].trim().length > 0 &&
    typeof candidate['domain'] === 'string' &&
    candidate['domain'].trim().length > 0 &&
    Number.isSafeInteger(candidate['namespaceId']) &&
    (candidate['namespaceId'] as number) >= 0 &&
    Number.isSafeInteger(candidate['profileRev']) &&
    (candidate['profileRev'] as number) >= 0 &&
    (candidate['domain'] === 'local') === (candidate['namespaceId'] === 0) &&
    (candidate['account'] !== '$system' ||
      (candidate['domain'] === 'local' && candidate['profileRev'] === 0))
  );
}

export function profileKeyForAddress(
  value: ProfiledAddress,
): ProfileKey | undefined {
  if (value.profileRev === 0) return undefined;
  return {
    account: value.account,
    domain: value.domain,
    namespaceId: value.namespaceId,
    rev: value.profileRev,
  };
}
