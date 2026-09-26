/** Durable, account-owned conversation identity and authorization snapshot. */
export interface ThreadStateSnapshot {
  threadId: number;
  type: 'P2P' | 'GROUP';
  authorityNamespaceId: number;
  conversationState: 'ACTIVE' | 'READ_ONLY';
  blocked: boolean;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  profile: {
    account: string;
    domain: string;
    namespaceId: number;
    profileRev: number;
  };
}

export function isThreadStateSnapshot(
  value: unknown,
): value is ThreadStateSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const integer = (n: unknown, minimum = 0) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= minimum;
  const p = v['profile'];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const profile = p as Record<string, unknown>;
  const account = profile['account'];
  const domain = profile['domain'];
  return (
    integer(v['threadId'], 1) &&
    integer(v['authorityNamespaceId']) &&
    (v['type'] === 'P2P' || v['type'] === 'GROUP') &&
    (v['conversationState'] === 'ACTIVE' ||
      v['conversationState'] === 'READ_ONLY') &&
    typeof v['blocked'] === 'boolean' &&
    (v['role'] === null ||
      (v['type'] === 'GROUP' &&
        ['OWNER', 'ADMIN', 'MEMBER'].includes(String(v['role'])))) &&
    typeof account === 'string' &&
    account.length > 0 &&
    typeof domain === 'string' &&
    domain.length > 0 &&
    integer(profile['namespaceId']) &&
    integer(profile['profileRev']) &&
    (domain === 'local'
      ? profile['namespaceId'] === 0
      : Number(profile['namespaceId']) > 0) &&
    v['authorityNamespaceId'] === profile['namespaceId']
  );
}
