import { describe, expect, it, vi } from 'vitest';
import { LocalInformationService } from './local-information.service.js';

describe('LocalInformationService', () => {
  it('reads public local facts only and never invokes private-key or probe methods', () => {
    const keys = {
      getStatus: () => ({ available: true }),
      getIdentityDomain: () => 'local.test',
      getKeyId: () => 'local.test/key',
      getPublicKeyB64: () => 'public',
      getRootPublicKeyB64: () => 'root-public',
      getCreatedAt: () => 1000,
      getRootEpochs: () => [],
      getSigningKeyCertificates: () => [],
      getPrivateKey: vi.fn(() => {
        throw new Error('private key accessed');
      }),
    };
    const network = {
      local: vi.fn(() => ({ runtime: 'docker', interfaces: [] })),
      probe: vi.fn(),
    };
    const result = new LocalInformationService(
      keys as never,
      network as never,
    ).get();
    expect(result.identity).toMatchObject({
      namespaceId: 0,
      domain: 'local.test',
      publicKey: 'public',
      rootPublicKey: 'root-public',
    });
    expect(keys.getPrivateKey).not.toHaveBeenCalled();
    expect(network.probe).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('privateKey');
  });
  it('still returns runtime information when identity is unavailable', () => {
    const keys = { getStatus: () => ({ available: false }) };
    const network = { local: () => ({ runtime: 'unknown', interfaces: [] }) };
    expect(
      new LocalInformationService(keys as never, network as never).get(),
    ).toMatchObject({ identity: null, runtime: 'unknown' });
  });
});
