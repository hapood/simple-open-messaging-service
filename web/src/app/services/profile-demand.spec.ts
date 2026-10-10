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

  it('resolves a publisher-owned message using its projected home namespace', () => {
    const message = {
      publisherNamespaceId: 7,
      creator: { account: 'alice', namespaceId: 7 },
      profileRev: 3,
    };
    expect(messageAuthorProfileDemand(message)).toEqual({
      publisherNamespaceId: 7,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'alice', rev: 3 },
    });
  });

  it('keeps a foreign subject namespace distinct from the publisher', () => {
    const message = {
      publisherNamespaceId: 7,
      creator: { account: 'bob', namespaceId: 4 },
      profileRev: 2,
    };
    expect(messageAuthorProfileDemand(message)?.target.profileNamespaceId).toBe(
      4,
    );
  });
});
