import { describe, expect, it } from 'vitest';
import { isProfileSelector } from './profile-selector.js';

describe('profile selector contract', () => {
  it.each([
    { type: 'EXACT', account: 'alice', domain: 'local', rev: 1 },
    { type: 'MESSAGE_AUTHOR', threadId: 1, messageSeq: 2 },
    {
      type: 'GROUP_MEMBER',
      threadId: 1,
      memberAccount: 'alice',
      memberDomain: 'local',
    },
  ])('accepts the discriminated selector $type', (selector) => {
    expect(isProfileSelector(selector)).toBe(true);
  });
  it.each([
    { type: 'THREAD_DEFAULT', threadId: 1 },
    { account: 'alice', domain: 'local', rev: 1 },
    { type: 'EXACT', account: 'alice', domain: 'local', rev: 0 },
    { type: 'EXACT', account: 'alice', domain: 'local', rev: 1, threadId: 1 },
    {
      type: 'MESSAGE_AUTHOR',
      threadId: 1,
      messageSeq: 2,
      memberAccount: 'alice',
    },
    { type: 'GROUP_MEMBER', threadId: 1, memberAccount: 'alice' },
    { type: 'EXACT', account: {}, domain: 'local', rev: 1 },
  ])('rejects incomplete, obsolete or mixed selectors: %j', (selector) => {
    expect(isProfileSelector(selector)).toBe(false);
  });
});
