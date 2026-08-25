import { describe, expect, it } from 'vitest';
import {
  parseSystemMessageContent,
  stringifySystemMessageContent,
  SystemMessageType,
} from './system-message.js';

describe('system message content', () => {
  it('round-trips the display-only structured body', () => {
    const body = {
      type: SystemMessageType.GROUP_OWNER_TRANSFERRED,
      subject: { account: 'bob', domain: 'chat.example' },
      actor: { account: 'alice', domain: 'chat.example' },
    } as const;
    expect(
      parseSystemMessageContent(stringifySystemMessageContent(body)),
    ).toEqual(body);
  });

  it('rejects action-like or malformed bodies', () => {
    expect(
      parseSystemMessageContent(JSON.stringify({ type: 'DELETE_MEMBER' })),
    ).toBeNull();
    expect(
      parseSystemMessageContent(
        JSON.stringify({ type: SystemMessageType.GROUP_LEFT }),
      ),
    ).toBeNull();
    expect(
      parseSystemMessageContent(
        JSON.stringify({
          type: SystemMessageType.FRIEND_ADDED,
          subject: { account: 'bob', domain: 'chat.example' },
        }),
      ),
    ).toBeNull();
    expect(
      parseSystemMessageContent(
        JSON.stringify({
          type: SystemMessageType.GROUP_LEFT,
          subject: { account: 'bob', domain: 'local' },
          action: true,
        }),
      ),
    ).toBeNull();
  });

  it('validates deletion event-specific fields', () => {
    expect(
      parseSystemMessageContent(
        stringifySystemMessageContent({
          type: SystemMessageType.MESSAGE_WITHDRAWN,
          subject: { account: 'alice', domain: 'chat.example' },
        }),
      ),
    ).not.toBeNull();
    expect(
      parseSystemMessageContent(
        stringifySystemMessageContent({
          type: SystemMessageType.MESSAGES_MODERATED,
          count: 3,
        }),
      ),
    ).not.toBeNull();
    expect(
      parseSystemMessageContent(
        JSON.stringify({
          type: SystemMessageType.MESSAGES_MODERATED,
          count: 0,
        }),
      ),
    ).toBeNull();
  });
});
