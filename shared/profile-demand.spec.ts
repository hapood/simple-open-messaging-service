import { describe, expect, it } from 'vitest';
import {
  parseProfileDemand,
  ProfileDemandParseError,
} from './profile-demand.js';

describe('profile demand parser', () => {
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
