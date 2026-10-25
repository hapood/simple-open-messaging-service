import { createP2PConversation } from './model';

describe('P2P conversation construction', () => {
  it('keeps the required profile revision separate from peer identity and display defaults', () => {
    const item = createP2PConversation(7, {
      account: 'bob',
      namespaceId: 4,
      profileRev: 5,
    });
    expect(item.profileRev).toBe(5);
    expect(item.publisherNamespaceId).toBe(4);
    expect(item.peerUser).toEqual({
      account: 'bob',
      namespaceId: 4,
      name: '',
      bio: '',
      isGroup: false,
      isDeleted: false,
    });
  });

  it('accepts a materialized display override without changing identity coordinates', () => {
    const item = createP2PConversation(7,
      { account: 'bob', namespaceId: 4, profileRev: 5 },
      {
        peerUser: {
          account: 'other',
          namespaceId: 0,
          name: 'Bob',
          bio: 'Hello',
          isGroup: false,
          isDeleted: false,
        },
      },
    );
    expect(item.peerUser).toMatchObject({
      account: 'bob', namespaceId: 4, name: 'Bob', bio: 'Hello',
    });
    expect(item.peerUser).not.toHaveProperty('domain');
    expect(item.peerUser).not.toHaveProperty('createdAt');
    expect(item.peerUser).not.toHaveProperty('updatedAt');
    expect(item.peerUser).not.toHaveProperty('profileRev');
  });
});
