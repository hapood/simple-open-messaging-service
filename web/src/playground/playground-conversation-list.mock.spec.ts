import { createGroupConversation } from '../app/services/model';
import { PlaygroundConversationList } from './playground-conversation-list.mock';

describe('PlaygroundConversationList', () => {
  it('applies group settings without replacing the rest of the group', () => {
    const conversations = new PlaygroundConversationList();
    conversations.setConversation(
      createGroupConversation(2, {
        id: 2,
        account: '!playground',
        name: 'Playground Team',
        description: 'Before',
      }),
    );

    conversations.applyGroupUpdate(2, { description: 'After' });

    expect(conversations.current()?.group).toEqual(
      expect.objectContaining({
        id: 2,
        name: 'Playground Team',
        description: 'After',
      }),
    );
  });
});
