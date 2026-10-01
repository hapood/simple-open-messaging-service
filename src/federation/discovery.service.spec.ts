import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { signingCertificateStatement } from './federation-certificate.js';
import { DiscoveryService } from './discovery.service.js';
import type { WellKnownDoc } from './discovery.service.js';

process.env.SOMS_DOMAIN = 'local.example';

function certificate(rootPrivateKey: Uint8Array, keyId: string, seed: number) {
  const privateKey = Uint8Array.from(
    { length: 32 },
    (_, index) => seed + index,
  );
  const unsigned = {
    keyId,
    ed25519: Buffer.from(ed25519.getPublicKey(privateKey)).toString('base64'),
    root: Buffer.from(ed25519.getPublicKey(rootPrivateKey)).toString('base64'),
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
  return new DiscoveryService(
    {} as never,
    {} as never,
    {
      acquire: async () => () => undefined,
    } as never,
    { get: () => ({ keyCacheTtlSec: 21_600 }) } as never,
  );
}

afterEach(() => vi.useRealTimers());

describe('DiscoveryService root-authorized signing certificates', () => {
  const rootPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const rootPublicKey = Buffer.from(
    ed25519.getPublicKey(rootPrivateKey),
  ).toString('base64');

  it('accepts an overlap set for online signing-key rotation', () => {
    const document = service().validateWellKnown('peer.example', {
      protocolVersions: [1],
      roots: [{ ed25519: rootPublicKey, notBefore: 1_600_000_000_000, notAfter: 1_900_000_000_000 }],
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
        roots: [{ ed25519: rootPublicKey, notBefore: 1_600_000_000_000, notAfter: 1_900_000_000_000 }],
        keys: [certificate(otherRoot, 'peer.example/key-1', 32)],
      }),
    ).toThrow('invalid signing certificate');
  });

  it('rejects duplicate key IDs and cross-domain certificates', () => {
    const key = certificate(rootPrivateKey, 'peer.example/key-1', 32);
    expect(() =>
      service().validateWellKnown('peer.example', {
        protocolVersions: [1],
        roots: [{ ed25519: rootPublicKey, notBefore: 1_600_000_000_000, notAfter: 1_900_000_000_000 }],
        keys: [key, key],
      }),
    ).toThrow('invalid signing certificate');
    expect(() =>
      service().validateWellKnown('peer.example', {
        protocolVersions: [1],
        roots: [{ ed25519: rootPublicKey, notBefore: 1_600_000_000_000, notAfter: 1_900_000_000_000 }],
        keys: [certificate(rootPrivateKey, 'other.example/key-1', 32)],
      }),
    ).toThrow('invalid signing certificate');
  });
});

describe('DiscoveryService peer-key refresh policy', () => {
  const rootPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const rootPublicKey = Buffer.from(
    ed25519.getPublicKey(rootPrivateKey),
  ).toString('base64');

  function doc(): WellKnownDoc {
    const unsigned = {
      keyId: 'peer.example/k-1',
      ed25519: Buffer.from(
        ed25519.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)),
      ).toString('base64'),
      root: rootPublicKey,
      notBefore: 1_700_000_000_000,
      notAfter: 1_800_000_000_000,
    };
    return {
      protocolVersions: [1],
      roots: [{ ed25519: rootPublicKey, notBefore: 1_600_000_000_000, notAfter: 1_900_000_000_000 }],
      keys: [
        {
          ...unsigned,
          authorizationSignature: Buffer.from(
            ed25519.sign(
              Buffer.from(signingCertificateStatement(unsigned)),
              rootPrivateKey,
            ),
          ).toString('base64'),
        },
      ],
    };
  }

  function refreshable() {
    const target = service();
    let resolveFetch!: (value: WellKnownDoc) => void;
    const fetchWellKnown = vi
      .spyOn(target, 'fetchWellKnown')
      .mockImplementation(
        () =>
          new Promise<WellKnownDoc>((resolve) => {
            resolveFetch = resolve;
          }),
      );
    const cacheDocument = vi
      .spyOn(target, 'cacheDocument')
      .mockResolvedValue(undefined);
    return {
      target,
      fetchWellKnown,
      cacheDocument,
      resolve: () => resolveFetch(doc()),
    };
  }

  it('coalesces concurrent non-Health key misses into one well-known fetch', async () => {
    const { target, fetchWellKnown, cacheDocument, resolve } = refreshable();
    const first = target.refreshPeerKeys('peer.example', 12);
    const second = target.refreshPeerKeys('peer.example', 12);
    expect(fetchWellKnown).toHaveBeenCalledTimes(1);

    resolve();
    await Promise.all([first, second]);
    expect(cacheDocument).toHaveBeenCalledTimes(1);
  });

  it('rate-limits repeated refresh attempts for one peer', async () => {
    const { target, fetchWellKnown } = refreshable();
    fetchWellKnown.mockResolvedValue(doc());
    await target.refreshPeerKeys('peer.example', 12);
    expect(fetchWellKnown).toHaveBeenCalledTimes(1);

    // An immediate second miss inside the minimum spacing window is skipped.
    await target.refreshPeerKeys('peer.example', 12);
    expect(fetchWellKnown).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight entry after a failed refresh so a retry can run', async () => {
    const { target, fetchWellKnown } = refreshable();
    fetchWellKnown.mockRejectedValue(new Error('offline'));
    await expect(target.refreshPeerKeys('peer.example', 12)).rejects.toThrow(
      'offline',
    );
    expect(target['refreshInFlight'].size).toBe(0);
  });

  it('refreshes after a successful Health round trip only when coverage is about to end', async () => {
    const target = service();
    const refreshPeerKeys = vi
      .spyOn(target, 'refreshPeerKeys')
      .mockResolvedValue(undefined);
    const now = Date.now();
    const rows: Array<{ notBefore: Date; notAfter: Date }> = [];
    const database = {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              then: (resolve: (value: typeof rows) => unknown) =>
                Promise.resolve(rows).then(resolve),
            }),
          }),
        }),
      },
    };
    Object.defineProperty(target, 'database', {
      get: () => database as never,
    });

    // Far coverage: no refresh.
    rows.length = 0;
    rows.push({
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + 86_400_000),
    });
    target.refreshAfterHealthSuccess('peer.example', 12);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshPeerKeys).not.toHaveBeenCalled();

    // Coverage ending inside the TTL window: refresh.
    rows.length = 0;
    rows.push({
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + 3_600_000),
    });
    target.refreshAfterHealthSuccess('peer.example', 12);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshPeerKeys).toHaveBeenCalledWith('peer.example', 12);
  });
});
