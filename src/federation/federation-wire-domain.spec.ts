import { describe, expect, it } from 'vitest';
import {
  toFederationWireDomain,
  toProfileWireDomain,
} from './federation-wire-domain.js';

describe('federation wire domain helpers', () => {
  it('keeps the protocol local marker for general outbound subjects', () => {
    expect(toFederationWireDomain('local')).toBe('local');
  });

  it('leaves a foreign domain unchanged for general outbound subjects', () => {
    expect(toFederationWireDomain('peer.example')).toBe('peer.example');
  });

  it('serializes zero-namespace profile subjects as local', () => {
    expect(toProfileWireDomain('peer.example', 0)).toBe('local');
  });

  it('uses the retained domain for positive profile namespaces', () => {
    expect(toProfileWireDomain('peer.example', 7)).toBe('peer.example');
  });
});
