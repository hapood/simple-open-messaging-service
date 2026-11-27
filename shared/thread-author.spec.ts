import { describe, expect, it } from 'vitest';
import { assertThreadAuthor } from './thread-author.js';

describe('thread head author contract', () => {
  it('omits author only for the zero head', () => {
    expect(() => assertThreadAuthor(0, undefined)).not.toThrow();
    for (const author of [null, { account: 'alice', namespaceId: 0 }])
      expect(() => assertThreadAuthor(0, author)).toThrow('omit author');
    for (const author of [null, undefined])
      expect(() => assertThreadAuthor(1, author)).toThrow('requires an author');
  });

  it.each(['alice', '$system'])('accepts %s without profile or body metadata', (account) => {
    expect(() => assertThreadAuthor(42, { account, namespaceId: 7 })).not.toThrow();
  });

  it.each([
    {}, [], '',
    { account: '', namespaceId: 0 },
    { account: ' ', namespaceId: 0 },
    { account: 'alice', namespaceId: -1 },
    { account: 'alice', namespaceId: 1.5 },
    { account: 'alice', namespaceId: '0' },
    { account: 'alice', namespaceId: Number.NaN },
    { account: 'alice', namespaceId: 0, seq: 42 },
    { account: 'alice', namespaceId: 0, domain: 'example.com' },
    { account: 'alice', namespaceId: 0, profileRev: 1 },
    { account: 'alice', domain: 'example.com' },
  ])('rejects invalid or expanded identity %j', (author) => {
    expect(() => assertThreadAuthor(42, author)).toThrow();
  });

  it.each([-1, 1.5, Number.NaN, 2_147_483_648])('rejects invalid head %s', (head) => {
    expect(() => assertThreadAuthor(head, { account: 'alice', namespaceId: 0 })).toThrow('message head');
  });
});
