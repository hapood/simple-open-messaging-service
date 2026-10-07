import { describe, expect, it } from 'vitest';
import {
  validateNamespacedAddress,
  validateNamespacedAddressOrNull,
} from './client-identity.js';

describe('validateNamespacedAddress', () => {
  it('does not infer locality from the configured domain', () => {
    const source = {
      account: 'not-registered',
      domain: 'bravo.test',
      namespaceId: 7,
    };
    expect(validateNamespacedAddress(source)).toEqual(source);
    expect(source).toEqual({
      account: 'not-registered',
      domain: 'bravo.test',
      namespaceId: 7,
    });
  });

  it('preserves a foreign subject publisher namespace', () => {
    expect(
      validateNamespacedAddress({
        account: 'member',
        domain: 'charlie.test',
        namespaceId: 7,
      }),
    ).toEqual({ account: 'member', domain: 'charlie.test', namespaceId: 7 });
  });

  it('preserves a valid namespace-zero address without special domain spelling', () => {
    const identity = {
      account: 'member',
      domain: 'member.example',
      namespaceId: 0,
    };
    expect(validateNamespacedAddress(identity)).toEqual(identity);
  });

  it('accepts a real domain with any non-zero namespace', () => {
    expect(
      validateNamespacedAddressOrNull({
        account: 'member',
        domain: 'local.example.test',
        namespaceId: 7,
      }),
    ).toEqual({
      account: 'member',
      domain: 'local.example.test',
      namespaceId: 7,
    });
  });
});
