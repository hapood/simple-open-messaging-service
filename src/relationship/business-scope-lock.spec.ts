import { describe, expect, it } from 'vitest';
import {
  groupBusinessScopeKey,
  userPairBusinessScopeKey,
} from './business-scope-lock.js';

describe('business scope lock keys', () => {
  it('uses one canonical key for either user-pair direction', () => {
    const alice = { domain: 'B.Example', account: 'alice' };
    const bob = { domain: 'a.example', account: 'bob' };

    expect(userPairBusinessScopeKey([alice, bob])).toBe(
      userPairBusinessScopeKey([bob, alice]),
    );
    expect(userPairBusinessScopeKey([alice, bob])).toBe(
      '["business-scope","USER_PAIR",["a.example","bob"],["b.example","alice"]]',
    );
  });

  it('uses the group address as the complete group scope', () => {
    expect(
      groupBusinessScopeKey({
        domain: 'Peer.Example',
        account: '!group',
      }),
    ).toBe('["business-scope","GROUP","peer.example","!group"]');
  });
});
