import { describe, expect, it } from 'vitest';
import type { Message } from '../message/message.service.js';
import type { FederationThreadAddress } from './federation-message-feed.service.js';
import {
  selectInboundMessageProfileDemand,
  selectInboundMessageProfileEvidenceProjection,
} from './select-inbound-message-profile-demand.js';

const stored = {
  profileRev: 4,
  creatorAccount: 'alice',
  profileNamespaceId: 12,
  publisherNamespaceId: 7,
  isDeleted: false,
  threadId: 9,
  seq: 70,
} as Message;

describe('selectInboundMessageProfileDemand', () => {
  it('selects ACCOUNT_PROFILE for a P2P thread account', () => {
    expect(
      selectInboundMessageProfileDemand(
        { account: 'alice', peerAccount: 'bob' },
        stored,
        7,
        12,
      ),
    ).toEqual({
      publisherNamespaceId: 7,
      lookup: 'ACCOUNT_PROFILE',
      target: {
        profileNamespaceId: 12,
        account: 'alice',
        rev: 4,
      },
    });
  });

  it('selects GROUP_MEMBER_PROFILE from the group-account prefix', () => {
    expect(
      selectInboundMessageProfileDemand(
        { account: '!GROUP' },
        stored,
        7,
        12,
      ),
    ).toEqual({
      publisherNamespaceId: 7,
      lookup: 'GROUP_MEMBER_PROFILE',
      target: {
        profileNamespaceId: 12,
        account: 'alice',
        rev: 4,
      },
      groupAccount: '!group',
    });
  });

  it('selects matching P2P evidence projection separately from demand', () => {
    expect(
      selectInboundMessageProfileEvidenceProjection(
        { account: 'alice', peerAccount: 'bob' },
        stored,
        7,
        12,
      ),
    ).toEqual({
      profile: {
        publisherNamespaceId: 7,
        profileNamespaceId: 12,
        account: 'alice',
        rev: 4,
      },
      lookup: 'ACCOUNT_PROFILE',
      projection: { threadId: 9, messageSeq: 70 },
    });
  });

  it('selects matching group-member evidence projection separately from demand', () => {
    expect(
      selectInboundMessageProfileEvidenceProjection(
        { account: '!GROUP' },
        stored,
        7,
        12,
      ),
    ).toEqual({
      profile: {
        publisherNamespaceId: 7,
        profileNamespaceId: 12,
        account: 'alice',
        rev: 4,
      },
      lookup: 'GROUP_MEMBER_PROFILE',
      groupAccount: '!group',
      projection: { threadId: 9, messageSeq: 70 },
    });
  });

  it('keeps a remote profile namespace zero distinct from its publisher', () => {
    expect(
      selectInboundMessageProfileDemand(
        { account: 'alice', peerAccount: 'bob' },
        stored,
        7,
        0,
      ),
    ).toMatchObject({
      publisherNamespaceId: 7,
      target: { profileNamespaceId: 0 },
    });
  });

  it.each([
    ['publisher namespace zero', stored, 0],
    ['zero revision', { ...stored, profileRev: 0 }, 7],
    ['deleted message', { ...stored, isDeleted: true }, 7],
  ])(
    'does not create demand or evidence for %s',
    (_label, message, namespaceId) => {
      const thread = { account: 'alice', peerAccount: 'bob' };
      expect(
        selectInboundMessageProfileDemand(
          thread,
          message as Message,
          namespaceId as number,
          12,
        ),
      ).toBeUndefined();
      expect(
        selectInboundMessageProfileEvidenceProjection(
          thread,
          message as Message,
          namespaceId as number,
          12,
        ),
      ).toBeUndefined();
    },
  );
});
