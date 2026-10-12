import { describe, expect, it } from 'vitest';
import {
  parseProfileDemand,
  parseProfileRequest,
  ProfileDemandParseError,
  messageProfileKey,
  profileNamespacePair,
} from './profile-demand.js';

describe('publisher-scoped message profile coordinates', () => {
  it.each([[0, 0], [7, 0], [7, 7], [1, 2]])(
    'preserves publisher %i and profile namespace %i independently',
    (publisherNamespaceId, profileNamespaceId) => {
      const message = {
        publisherNamespaceId,
        profileNamespaceId,
        profileRev: 3,
        creator: { account: 'alice', namespaceId: 99 },
      };
      const key = messageProfileKey(message);
      expect(key).toEqual({
        publisherNamespaceId,
        profileNamespaceId,
        account: 'alice',
        rev: 3,
      });
      expect(profileNamespacePair(key)).toEqual({
        publisherNamespaceId,
        profileNamespaceId,
      });
    },
  );
});

describe('profile demand parser', () => {
  const demand = {
    publisherNamespaceId: 3,
    lookup: 'ACCOUNT_PROFILE',
    target: { profileNamespaceId: 5, account: 'alice', rev: 7 },
  };

  it('accepts current resolution and one-shot lookup requests with the same target', () => {
    expect(parseProfileRequest(demand)).toEqual(demand);
    expect(parseProfileRequest({ demand, evidence: null })).toEqual({
      demand,
      evidence: null,
    });
  });

  it.each([
    { demand },
    { demand, evidence: undefined },
    { demand, evidence: false },
    { demand, evidence: {} },
    { demand, evidence: null, cacheOnly: true },
    { type: 'MESSAGE_AUTHOR', threadId: 7, messageSeq: 1, rev: 2 },
    {
      type: 'GROUP_META',
      threadId: 7,
      profileRev: 2,
      subject: { type: 'GROUP' },
    },
  ])('rejects incomplete envelopes and obsolete selectors %#', (request) => {
    expect(() => parseProfileRequest(request)).toThrow(ProfileDemandParseError);
  });

  it.each([
    {
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'alice', rev: 1 },
    },
    {
      publisherNamespaceId: 8,
      lookup: 'GROUP_MEMBER_PROFILE',
      target: { profileNamespaceId: 8, account: 'alice', rev: 3 },
      groupAccount: '!group',
    },
  ])('accepts the closed demand shape %#', (demand) => {
    expect(parseProfileDemand(demand)).toEqual(demand);
  });

  it.each([
    null,
    { type: 'EXACT', account: 'alice', domain: 'local', rev: 1 },
    {
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'alice', rev: 1 },
      peerAccount: 'bob',
    },
    {
      publisherNamespaceId: 1,
      lookup: 'RELATIONSHIP_INTENT_PROFILE',
      target: { profileNamespaceId: 1, account: 'alice', rev: 1 },
      peerAccount: 'bob',
    },
    {
      publisherNamespaceId: 1,
      lookup: 'GROUP_MEMBER_PROFILE',
      target: { profileNamespaceId: 1, account: 'alice', rev: 1 },
      groupAccount: '',
    },
    {
      publisherNamespaceId: 1,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 1, account: 'alice', rev: 0 },
    },
  ])('rejects malformed or obsolete demands %#', (value) => {
    expect(() => parseProfileDemand(value)).toThrow(ProfileDemandParseError);
  });
});
