import { describe, expect, it } from 'vitest';
import { toClientIdentity } from './client-identity.js';

describe('toClientIdentity', () => {
  it('maps an unregistered local address without resolving an Account', () => {
    const source = {
      account: 'not-registered',
      domain: 'bravo.test',
      namespaceId: 7,
    };
    expect(toClientIdentity(source, 'bravo.test')).toEqual({
      account: 'not-registered',
      domain: 'local',
      namespaceId: 0,
    });
    expect(source).toEqual({
      account: 'not-registered',
      domain: 'bravo.test',
      namespaceId: 7,
    });
  });

  it('preserves a foreign subject publisher namespace', () => {
    expect(
      toClientIdentity(
        { account: 'member', domain: 'charlie.test', namespaceId: 7 },
        'bravo.test',
      ),
    ).toEqual({ account: 'member', domain: 'charlie.test', namespaceId: 7 });
  });

  it('is idempotent for an already local identity', () => {
    const identity = { account: 'member', domain: 'local', namespaceId: 0 };
    expect(toClientIdentity(identity, 'bravo.test')).toEqual(identity);
  });
});
