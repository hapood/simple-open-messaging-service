import {
  homeProfileDemand,
  messageAuthorProfileDemand,
} from './profile-demand';

describe('profile demand coordinates', () => {
  it('uses the home publisher and its own subject namespace zero', () => {
    expect(homeProfileDemand('alice', 7, 3)).toEqual({
      publisherNamespaceId: 7,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'alice', rev: 3 },
    });
  });

  it('resolves a publisher-owned message using its preserved profile namespace', () => {
    const message = {
      publisherNamespaceId: 7,
      profileNamespaceId: 0,
      creator: { account: 'alice', namespaceId: 7 },
      profileRev: 3,
    };
    expect(messageAuthorProfileDemand(message)).toEqual({
      publisherNamespaceId: 7,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'alice', rev: 3 },
    });
  });

  it('does not rewrite numerically equal coordinates in distinct spaces', () => {
    expect(messageAuthorProfileDemand({
      publisherNamespaceId: 7,
      profileNamespaceId: 7,
      creator: { account: 'bob', namespaceId: 7 },
      profileRev: 2,
    })).toEqual({
      publisherNamespaceId: 7,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 7, account: 'bob', rev: 2 },
    });
  });

  it('keeps a foreign subject namespace distinct from the publisher', () => {
    const message = {
      publisherNamespaceId: 7,
      profileNamespaceId: 4,
      creator: { account: 'bob', namespaceId: 4 },
      profileRev: 2,
    };
    expect(messageAuthorProfileDemand(message)?.target.profileNamespaceId).toBe(
      4,
    );
  });
});
