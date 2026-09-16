import { afterEach, describe, expect, it, vi } from 'vitest';
import { toFederationWireDomain } from './federation-wire-domain.js';

describe('toFederationWireDomain', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('converts the storage-only local marker to the public server domain', () => {
    vi.stubEnv('SOMS_DOMAIN', 'node.example');

    expect(toFederationWireDomain('local')).toBe('node.example');
  });

  it('leaves a foreign domain unchanged', () => {
    vi.stubEnv('SOMS_DOMAIN', 'node.example');

    expect(toFederationWireDomain('peer.example')).toBe('peer.example');
  });
});
