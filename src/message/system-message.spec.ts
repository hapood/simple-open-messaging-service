import { describe, expect, it } from 'vitest';
import {
  parseSystemMessageContent,
  stringifySystemMessageContent,
  SystemMessageType,
} from './system-message.js';

const me = {
  account: 'alice',
  profileNamespaceId: 0,
  profileRev: 2,
};
const peer = {
  account: 'bob',
  profileNamespaceId: 12,
  profileRev: 3,
};
const system = {
  account: '$system',
  profileNamespaceId: 0,
  profileRev: 0,
};

describe('system message content', () => {
  it('round-trips immutable identities on every event', () => {
    const events = [
      { type: SystemMessageType.FRIEND_ADDED, participants: [me, peer] },
      {
        type: SystemMessageType.FRIEND_REMOVED,
        initiator: me,
        participants: [me, peer],
      },
      {
        type: SystemMessageType.FRIEND_REMOVED,
        initiator: system,
        participants: [me, peer],
      },
      { type: SystemMessageType.GROUP_CREATED, creator: me },
      { type: SystemMessageType.GROUP_LEFT, member: peer },
      {
        type: SystemMessageType.GROUP_OWNER_TRANSFERRED,
        previousOwner: me,
        newOwner: peer,
      },
      { type: SystemMessageType.GROUP_DISSOLVED },
    ];
    for (const event of events) {
      const content = JSON.stringify(event);
      expect(parseSystemMessageContent(content)).toEqual(event);
      expect(
        stringifySystemMessageContent(
          event as Parameters<typeof stringifySystemMessageContent>[0],
        ),
      ).toBe(content);
    }
  });

  it('accepts address keys outside the wire contract such as domain', () => {
    expect(
      parseSystemMessageContent(
        JSON.stringify({
          type: SystemMessageType.GROUP_LEFT,
          member: { ...peer, domain: 'peer.test' },
        }),
      ),
    ).toMatchObject({ type: SystemMessageType.GROUP_LEFT, member: peer });
  });

  it.each([
    { type: 'DELETE_MEMBER' },
    { type: 'FRIEND_ADDED' },
    { type: 'FRIEND_REMOVED', initiator: me },
    { type: 'FRIEND_REMOVED', initiator: system, participants: [me] },
    { type: 'GROUP_LEFT', member: { account: 'bob' } },
    { type: 'GROUP_LEFT', member: { ...peer, profileRev: -1 } },
    { type: 'GROUP_LEFT', member: peer, action: true },
    { type: 'GROUP_CREATED', member: me },
    { type: 'GROUP_OWNER_TRANSFERRED', newOwner: peer },
    null,
    [],
  ])('rejects missing or malformed fields: %j', (body) => {
    expect(parseSystemMessageContent(JSON.stringify(body))).toBeNull();
  });
});
