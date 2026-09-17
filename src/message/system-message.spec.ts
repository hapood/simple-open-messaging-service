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
      newOwner: { account: 'bob', domain: 'chat.example' },
      previousOwner: { account: 'alice', domain: 'chat.example' },
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

  it.each([
    {
      type: 'FRIEND_REMOVED',
      initiator: { account: 'alice', domain: 'peer.test' },
    },
    {
      type: 'FRIEND_REMOVED',
      initiator: { account: 'alice', domain: 'local' },
    },
    {
      type: 'FRIEND_REMOVED',
      initiator: { account: '$system', domain: 'local' },
    },
    { type: 'GROUP_CREATED', creator: { account: 'alice', domain: 'local' } },
    { type: 'GROUP_LEFT', member: { account: 'bob', domain: 'peer.test' } },
  ])('accepts event-specific content: $type', (body) => {
    expect(parseSystemMessageContent(JSON.stringify(body))).toEqual(body);
  });

  it.each([
    { type: 'FRIEND_REMOVED', reason: 'USER_REQUEST' },
    {
      type: 'FRIEND_REMOVED',
      reason: 'AUTOMATIC',
      initiator: { account: 'alice', domain: 'local' },
    },
    {
      type: 'FRIEND_REMOVED',
      reason: 'USER_REQUEST',
      initiator: { account: '$system', domain: 'local' },
    },
    { type: 'GROUP_LEFT', subject: { account: 'bob', domain: 'local' } },
    {
      type: 'GROUP_CREATED',
      member: { account: 'alice', domain: 'local' },
    },
    {
      type: 'GROUP_LEFT',
      member: { account: 'bob', domain: 'local' },
      actor: { account: 'alice', domain: 'local' },
    },
    {
      type: 'GROUP_OWNER_TRANSFERRED',
      newOwner: { account: 'bob', domain: 'local' },
    },
    null,
    [],
  ])('rejects incomplete or generic participant fields: %j', (body) => {
    expect(parseSystemMessageContent(JSON.stringify(body))).toBeNull();
  });
});
