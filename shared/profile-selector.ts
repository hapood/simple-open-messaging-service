/** Client-to-server selectors. Federation endpoints retain their own wire contracts. */
export type ProfileSelector =
  | {
      type: 'EXACT';
      publisherNamespaceId: number;
      profileNamespaceId: number;
      account: string;
      domain: string;
      rev: number;
    }
  | {
      type: 'MESSAGE_AUTHOR';
      threadId: number;
      messageSeq: number;
      rev: number;
    }
  | {
      type: 'GROUP_META';
      threadId: number;
      profileRev: number;
      subject:
        | { type: 'GROUP' }
        | { type: 'MEMBER'; account: string; domain: string };
    };

/** Stable client/server identity of one immutable profile revision. */
export interface ProfileKey {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  account: string;
  domain: string;
  rev: number;
}

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
        keys(
          'publisherNamespaceId',
          'profileNamespaceId',
          'account',
          'domain',
          'rev',
        ) &&
        typeof v['publisherNamespaceId'] === 'number' &&
        Number.isSafeInteger(v['publisherNamespaceId']) &&
        v['publisherNamespaceId'] >= 0 &&
        typeof v['profileNamespaceId'] === 'number' &&
        Number.isSafeInteger(v['profileNamespaceId']) &&
        v['profileNamespaceId'] >= 0 &&
        address(v['account']) &&
        address(v['domain']) &&
        positive(v['rev'])
      );
    case 'MESSAGE_AUTHOR':
      return (
        keys('threadId', 'messageSeq', 'rev') &&
        positive(v['threadId']) &&
        positive(v['messageSeq']) &&
        positive(v['rev'])
      );
    case 'GROUP_META': {
      if (
        !keys('threadId', 'profileRev', 'subject') ||
        !positive(v['threadId']) ||
        !positive(v['profileRev']) ||
        !v['subject'] ||
        typeof v['subject'] !== 'object' ||
        Array.isArray(v['subject'])
      )
        return false;
      const subject = v['subject'] as Record<string, unknown>;
      if (subject['type'] === 'GROUP') return Object.keys(subject).length === 1;
      return (
        subject['type'] === 'MEMBER' &&
        Object.keys(subject).length === 3 &&
        Object.keys(subject).every((key) =>
          ['type', 'account', 'domain'].includes(key),
        ) &&
        address(subject['account']) &&
        address(subject['domain'])
      );
    }
    default:
      return false;
  }
}
