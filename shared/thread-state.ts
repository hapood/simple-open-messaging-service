/** Durable, account-owned conversation identity and authorization snapshot. */
export interface ThreadStateSnapshot {
  threadId: number;
  type: 'P2P' | 'GROUP';
  publisherNamespaceId: number;
  profileAccount: string;
  profileRev: number;
  conversationState: 'ACTIVE' | 'READ_ONLY';
  blocked: boolean;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
}

export function isThreadStateSnapshot(
  value: unknown,
): value is ThreadStateSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const integer = (n: unknown, minimum = 0) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= minimum;
  const account = v['profileAccount'];
  return (
    integer(v['threadId'], 1) &&
    integer(v['publisherNamespaceId']) &&
    integer(v['profileRev']) &&
    (v['type'] === 'P2P' || v['type'] === 'GROUP') &&
    (v['conversationState'] === 'ACTIVE' ||
      v['conversationState'] === 'READ_ONLY') &&
    typeof v['blocked'] === 'boolean' &&
    (v['role'] === null ||
      (v['type'] === 'GROUP' &&
        ['OWNER', 'ADMIN', 'MEMBER'].includes(String(v['role'])))) &&
    typeof account === 'string' &&
    account.length > 0
  );
}
