import { describe, expect, it } from 'vitest';
import { toClientIdentity, toClientIdentityOrNull } from './client-identity.js';

describe('toClientIdentity', () => {
  it('does not infer locality from the configured domain', () => {
    const source = {
      account: 'not-registered',
      domain: 'bravo.test',
      namespaceId: 7,
    };
    expect(toClientIdentity(source, 'bravo.test')).toEqual(source);
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

  it('is idempotent for a valid local marker', () => {
    const identity = { account: 'member', domain: 'local', namespaceId: 0 };
    expect(toClientIdentity(identity, 'bravo.test')).toEqual(identity);
  });

  it('lets inbound processors detect and drop local with a positive namespace', () => {
    expect(
      toClientIdentityOrNull({
        account: 'member',
        domain: 'local',
        namespaceId: 7,
      }),
    ).toBeNull();
    expect(() =>
      toClientIdentity({ account: 'member', domain: 'local', namespaceId: 7 }),
    ).toThrow('invalid local subject namespace');
  });
});
