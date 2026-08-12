import { beforeAll, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { signingCertificateStatement } from './federation-certificate.js';

process.env.SOMS_DOMAIN = 'local.example';

let DiscoveryService: typeof import('./discovery.service.js').DiscoveryService;

beforeAll(async () => {
  ({ DiscoveryService } = await import('./discovery.service.js'));
}, 30_000);

function certificate(rootPrivateKey: Uint8Array, keyId: string, seed: number) {
  const privateKey = Uint8Array.from(
    { length: 32 },
    (_, index) => seed + index,
  );
  const unsigned = {
    keyId,
    ed25519: Buffer.from(ed25519.getPublicKey(privateKey)).toString('base64'),
    notBefore: 1_700_000_000_000,
    notAfter: 1_800_000_000_000,
  };
  return {
    ...unsigned,
    authorizationSignature: Buffer.from(
      ed25519.sign(
        Buffer.from(signingCertificateStatement(unsigned)),
        rootPrivateKey,
      ),
    ).toString('base64'),
  };
}

function service() {
  return new DiscoveryService({} as never, {} as never);
}

describe('DiscoveryService root-authorized signing certificates', () => {
  const rootPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const rootPublicKey = Buffer.from(
    ed25519.getPublicKey(rootPrivateKey),
  ).toString('base64');

  it('accepts an overlap set for online signing-key rotation', () => {
    const document = service().validateWellKnown('peer.example', {
      protocolVersions: [1],
      rootKey: { ed25519: rootPublicKey },
      keys: [
        certificate(rootPrivateKey, 'peer.example/key-1', 32),
        certificate(rootPrivateKey, 'peer.example/key-2', 64),
      ],
    });
    expect(document.keys.map((key) => key.keyId)).toEqual([
      'peer.example/key-1',
      'peer.example/key-2',
    ]);
  });

  it('rejects a certificate not authorized by the published root', () => {
    const otherRoot = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    expect(() =>
      service().validateWellKnown('peer.example', {
        protocolVersions: [1],
        rootKey: { ed25519: rootPublicKey },
        keys: [certificate(otherRoot, 'peer.example/key-1', 32)],
      }),
    ).toThrow('invalid signing certificate');
  });

  it('rejects duplicate key IDs and cross-domain certificates', () => {
    const key = certificate(rootPrivateKey, 'peer.example/key-1', 32);
    expect(() =>
      service().validateWellKnown('peer.example', {
        protocolVersions: [1],
        rootKey: { ed25519: rootPublicKey },
        keys: [key, key],
      }),
    ).toThrow('invalid signing certificate');
    expect(() =>
      service().validateWellKnown('peer.example', {
        protocolVersions: [1],
        rootKey: { ed25519: rootPublicKey },
        keys: [certificate(rootPrivateKey, 'other.example/key-1', 32)],
      }),
    ).toThrow('invalid signing certificate');
  });
});
