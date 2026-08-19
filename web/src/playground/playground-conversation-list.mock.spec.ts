import type { ConversationItem } from '../app/services/model';
import { PlaygroundConversationList } from './playground-conversation-list.mock';

describe('PlaygroundConversationList', () => {
  it('applies group settings without replacing the rest of the group', () => {
    const conversations = new PlaygroundConversationList();
    conversations.setConversation({
      id: 2,
      threadId: 2,
      type: 'GROUP',
      group: {
        id: 2,
        name: 'Playground Team',
        membersCanInvite: true,
      },
    } as ConversationItem);

    conversations.applyGroupUpdate(2, { membersCanInvite: false });

    expect(conversations.current()?.group).toEqual(
      expect.objectContaining({
        id: 2,
        name: 'Playground Team',
        membersCanInvite: false,
      }),
    );
  });
});
