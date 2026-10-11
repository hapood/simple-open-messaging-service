import { describe, expect, it } from 'vitest';
import { messageAuthorHomeNamespaceId } from './deleted-message.service.js';

describe('messageAuthorHomeNamespaceId', () => {
  it('treats namespace-zero profiles on federated mirror rows as peer-publisher authors', () => {
    expect(
      messageAuthorHomeNamespaceId({
        profileNamespaceId: 0,
        publisherNamespaceId: 2,
      }),
    ).toBe(2);
  });

  it('keeps local namespace-zero authors local for local rows', () => {
    expect(
      messageAuthorHomeNamespaceId({
        profileNamespaceId: 0,
        publisherNamespaceId: 0,
      }),
    ).toBe(0);
  });

  it('uses explicit non-zero profile namespaces as the author home', () => {
    expect(
      messageAuthorHomeNamespaceId({
        profileNamespaceId: 7,
        publisherNamespaceId: 2,
      }),
    ).toBe(7);
  });
});
