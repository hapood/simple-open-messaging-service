import { describe, expect, it } from 'vitest';
import type { Message } from '../message/message.service.js';
import type { FederationMessageFeedMessage } from './federation-message-feed.service.js';
import {
  selectInboundMessageProfileDemand,
  selectInboundMessageProfileEvidenceProjection,
} from './select-inbound-message-profile-demand.js';

const stored = {
  profileRev: 4,
  creatorAccount: 'alice',
  creatorDomain: 'member.test',
  isDeleted: false,
  threadId: 9,
  seq: 70,
} as Message;

function item(thread: FederationMessageFeedMessage['thread']) {
  return { thread } as FederationMessageFeedMessage;
}

describe('selectInboundMessageProfileDemand', () => {
  it('selects ACCOUNT_PROFILE for a P2P thread account', () => {
    expect(
      selectInboundMessageProfileDemand(
        item({ account: 'alice', peerAccount: 'bob' }),
        stored,
        7,
      ),
    ).toEqual({
      namespaceId: 7,
      lookup: 'ACCOUNT_PROFILE',
      target: {
        account: 'alice',
        domain: 'member.test',
        rev: 4,
      },
    });
  });

  it('selects GROUP_MEMBER_PROFILE from the group-account prefix', () => {
    expect(
      selectInboundMessageProfileDemand(item({ account: '!GROUP' }), stored, 7),
    ).toEqual({
      namespaceId: 7,
      lookup: 'GROUP_MEMBER_PROFILE',
      target: {
        account: 'alice',
        domain: 'member.test',
        rev: 4,
      },
      groupAccount: '!group',
    });
  });

  it('selects matching P2P evidence projection separately from demand', () => {
    expect(
      selectInboundMessageProfileEvidenceProjection(
        item({ account: 'alice', peerAccount: 'bob' }),
        stored,
        7,
      ),
    ).toEqual({
      profile: {
        namespaceId: 7,
        account: 'alice',
        domain: 'member.test',
        rev: 4,
      },
      lookup: 'ACCOUNT_PROFILE',
      projection: { threadId: 9, messageSeq: 70 },
    });
  });

  it('selects matching group-member evidence projection separately from demand', () => {
    expect(
      selectInboundMessageProfileEvidenceProjection(
        item({ account: '!GROUP' }),
        stored,
        7,
      ),
    ).toEqual({
      profile: {
        namespaceId: 7,
        account: 'alice',
        domain: 'member.test',
        rev: 4,
      },
      lookup: 'GROUP_MEMBER_PROFILE',
      groupAccount: '!group',
      projection: { threadId: 9, messageSeq: 70 },
    });
  });

  it.each([
    ['namespace zero', stored, 0],
    ['local creator', { ...stored, creatorDomain: 'local' }, 7],
    ['zero revision', { ...stored, profileRev: 0 }, 7],
    ['deleted message', { ...stored, isDeleted: true }, 7],
  ])('does not create demand or evidence for %s', (_label, message, namespaceId) => {
    const thread = item({ account: 'alice', peerAccount: 'bob' });
    expect(
      selectInboundMessageProfileDemand(
        thread,
        message as Message,
        namespaceId as number,
      ),
    ).toBeUndefined();
    expect(
      selectInboundMessageProfileEvidenceProjection(
        thread,
        message as Message,
        namespaceId as number,
      ),
    ).toBeUndefined();
  });
});
