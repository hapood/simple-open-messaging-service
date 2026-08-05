import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

process.env.SOMS_DOMAIN = 'local.example';

let FederationIdentityService: typeof import('./federation-identity.service.js').FederationIdentityService;

beforeAll(async () => {
  ({ FederationIdentityService } = await import(
    './federation-identity.service.js'
  ));
});

function makeService(peer?: Record<string, unknown>) {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const updateSet = vi.fn();
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  updateSet.mockReturnValue({ where: updateWhere });
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const tx = {
    query: {
      federatedPeer: { findFirst: vi.fn().mockResolvedValue(peer) },
    },
    update: vi.fn().mockReturnValue({ set: updateSet }),
    insert: vi.fn().mockReturnValue({
      values: insertValues,
    }),
  };
  const database = {
    db: {
      transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
    },
  };
  const keypair = {
    getIdentityEpoch: () => 1,
    getPairwiseServerId: () => 'A'.repeat(43),
    getRootKeyFingerprint: () => `sha256:${'B'.repeat(43)}`,
    getPrivateKey: () => privateKey,
    getKeyId: () => 'local.example/key-1',
  };
  return {
    service: new FederationIdentityService(database as never, keypair as never),
    publicKey,
    updateSet,
    insertValues,
  };
}

describe('FederationIdentityService', () => {
  it('signs a recipient-bound claim and verifies the exact nonce', () => {
    const { service, publicKey } = makeService();
    const claim = service.createClaim('peer.example', 'n'.repeat(24));
    const signed = service.signClaim(claim);

    expect(
      service.verifySignedClaim(
        signed,
        'local.example',
        'peer.example',
        'n'.repeat(24),
        publicKey,
      ),
    ).toMatchObject(claim);
    expect(() =>
      service.verifySignedClaim(
        signed,
        'local.example',
        'other.example',
        'n'.repeat(24),
        publicKey,
      ),
    ).toThrow(BusinessException);
  });

  it('rejects stale identity claims', () => {
    const { service } = makeService();
    const claim = service.createClaim('peer.example', 'n'.repeat(24));
    claim.issuedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    expect(() =>
      service.validateClaim(claim, 'local.example', 'peer.example'),
    ).toThrow(BusinessException);
  });

  it('commits identity_lost before returning the mismatch error', async () => {
    const { service, updateSet, insertValues } = makeService({
      domain: 'peer.example',
      trustLevel: 'trusted',
      identityPinnedAt: new Date(),
      pairwiseServerId: 'old',
      rootKeyFingerprint: `sha256:${'C'.repeat(43)}`,
      identityEpoch: 1,
    });
    const claim = service.createClaim('local.example', 'n'.repeat(24));
    claim.originDomain = 'peer.example';
    claim.recipientDomain = 'local.example';

    await expect(
      service.pinOrVerify('peer.example', claim),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
    });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ trustLevel: 'identity_lost' }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'identity_lost' }),
    );
  });
});
