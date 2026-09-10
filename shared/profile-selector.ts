/** Client-to-server selectors. Federation endpoints retain their own wire contracts. */
export type ProfileSelector =
  | { type: 'EXACT'; account: string; domain: string; rev: number }
  | { type: 'MESSAGE_AUTHOR'; threadId: number; messageSeq: number }
  | {
      type: 'GROUP_MEMBER';
      threadId: number;
      memberAccount: string;
      memberDomain: string;
    };

/** Reject mixed selectors and unexpected fields at the trust boundary. */
export function isProfileSelector(value: unknown): value is ProfileSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const positive = (n: unknown) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  const address = (s: unknown) => typeof s === 'string' && s.trim().length > 0;
  const keys = (...fields: string[]) =>
    Object.keys(v).length === fields.length + 1 &&
    Object.keys(v).every((key) => key === 'type' || fields.includes(key));
  switch (v['type']) {
    case 'EXACT':
      return (
        keys('account', 'domain', 'rev') &&
        address(v['account']) &&
        address(v['domain']) &&
        positive(v['rev'])
      );
    case 'MESSAGE_AUTHOR':
      return (
        keys('threadId', 'messageSeq') &&
        positive(v['threadId']) &&
        positive(v['messageSeq'])
      );
    case 'GROUP_MEMBER':
      return (
        keys('threadId', 'memberAccount', 'memberDomain') &&
        positive(v['threadId']) &&
        address(v['memberAccount']) &&
        address(v['memberDomain'])
      );
    default:
      return false;
  }
}
