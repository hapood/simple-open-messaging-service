export type ProfileLookup = 'ACCOUNT_PROFILE' | 'GROUP_MEMBER_PROFILE';

/** Client-to-server profile-resolution demand. Federation endpoints retain their own wire contracts. */
export type ProfileDemand =
  | {
      publisherNamespaceId: number;
      lookup: 'ACCOUNT_PROFILE';
      target: ProfileTarget;
    }
  | {
      publisherNamespaceId: number;
      lookup: 'GROUP_MEMBER_PROFILE';
      target: ProfileTarget;
      groupAccount: string;
    };

export interface ProfileTarget {
  profileNamespaceId: number;
  account: string;
  rev: number;
}

/** Stable client/server identity of one immutable profile revision. */
export interface ProfileKey {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  account: string;
  rev: number;
}

export class ProfileDemandParseError extends Error {
  constructor(message = 'invalid profile demand') {
    super(message);
    this.name = 'ProfileDemandParseError';
  }
}

/** Parse the closed profile-resolution wire contract at untrusted JSON boundaries. */
export function parseProfileDemand(value: unknown): ProfileDemand {
  const demand = record(value, 'profile demand must be an object');
  const publisherNamespaceId = namespaceId(
    demand['publisherNamespaceId'],
    'publisherNamespaceId',
  );
  const target = parseProfileTarget(demand['target']);

  switch (demand['lookup']) {
    case 'ACCOUNT_PROFILE':
      assertOnlyKeys(demand, 'publisherNamespaceId', 'lookup', 'target');
      return { publisherNamespaceId, lookup: 'ACCOUNT_PROFILE', target };
    case 'GROUP_MEMBER_PROFILE': {
      assertOnlyKeys(
        demand,
        'publisherNamespaceId',
        'lookup',
        'target',
        'groupAccount',
      );
      return {
        publisherNamespaceId,
        lookup: 'GROUP_MEMBER_PROFILE',
        target,
        groupAccount: nonEmptyString(demand['groupAccount'], 'groupAccount'),
      };
    }
    default:
      throw new ProfileDemandParseError('unsupported profile lookup');
  }
}

function parseProfileTarget(value: unknown): ProfileTarget {
  const target = record(value, 'target must be an object');
  assertOnlyKeys(target, 'profileNamespaceId', 'account', 'rev');
  return {
    profileNamespaceId: namespaceId(
      target['profileNamespaceId'],
      'target.profileNamespaceId',
    ),
    account: nonEmptyString(target['account'], 'target.account'),
    rev: revision(target['rev'], 'target.rev'),
  };
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProfileDemandParseError(message);
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  ...expected: string[]
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  )
    throw new ProfileDemandParseError('profile demand has unexpected fields');
}

function namespaceId(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new ProfileDemandParseError(`${name} must be a non-negative integer`);
  return value;
}

function revision(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new ProfileDemandParseError(`${name} must be a positive integer`);
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new ProfileDemandParseError(`${name} must be a non-empty string`);
  return value;
}
