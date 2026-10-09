import { displayThreadName, type ConversationItem } from './model';

const thread = (name: string, namespaceId = 0): ConversationItem =>
  ({
    type: 'P2P',
    alias: null,
    peerUser: { name, account: 'bob', namespaceId },
  }) as unknown as ConversationItem;

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

  it('renders a group address on a cache miss', () => {
    const group = {
      type: 'GROUP',
      group: {
        name: '',
        account: '!team',
        domain: 'peer.test',
        namespaceId: 12,
      },
    } as ConversationItem;
    expect(displayThreadName(group)).toBe('!team@peer.test');
  });
});
