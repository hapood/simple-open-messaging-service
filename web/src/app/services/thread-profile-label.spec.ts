import {
  createGroupConversation,
  createP2PConversation,
  displayThreadName,
} from './model';

const thread = (name: string, namespaceId = 0) =>
  createP2PConversation({
    threadId: 1,
    account: 'bob',
    publisherNamespaceId: namespaceId,
    profileRev: 1,
    profile: { name, bio: '', avatarDigest: null },
  });

describe('thread profile label fallback', () => {
  it('keeps remarks and cached display names ahead of the account', () => {
    expect(displayThreadName(thread('Bob Profile'))).toBe('Bob Profile');
    expect(
      displayThreadName({ ...thread('Bob Profile'), alias: 'My friend' }),
    ).toBe('My friend');
  });

  it('renders a local account on a cache miss', () => {
    expect(displayThreadName(thread(''))).toBe('bob');
    expect(displayThreadName(thread('  '))).toBe('bob');
  });

  it('renders the foreign account while its namespace domain is resolved separately', () => {
    expect(displayThreadName(thread('', 12))).toBe('bob');
  });

  it('renders a group account on a cache miss without a duplicated domain', () => {
    const thread = createGroupConversation({
      threadId: 2,
      publisherNamespaceId: 12,
      account: '!team',
      profileRev: 1,
      profile: { name: '', bio: '', avatarDigest: null },
    });
    expect(displayThreadName(thread)).toBe('!team');
  });
});
