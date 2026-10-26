import { createGroupConversation } from '../app/services/model';
import { PlaygroundConversationList } from './playground-conversation-list.mock';

describe('PlaygroundConversationList', () => {
  it('applies group settings without replacing the rest of the group', () => {
    const conversations = new PlaygroundConversationList();
    conversations.setConversation(
      createGroupConversation({
        threadId: 2,
        account: '!playground',
        publisherNamespaceId: 0,
        profileRev: 0,
        profile: { name: 'Playground Team', bio: '', avatarDigest: null },
      }),
    );

    conversations.applyGroupUpdate(2, { profile: { bio: 'After' } });

    expect(conversations.current()?.profile).toEqual(
      expect.objectContaining({
        name: 'Playground Team',
        bio: 'After',
      }),
    );
  });
});
