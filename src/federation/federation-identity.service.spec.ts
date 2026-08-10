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
}, 30_000);

function makeService(
  peer?: Record<string, unknown>,
  reset?: Record<string, unknown>,
) {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const updateSet = vi.fn();
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  updateSet.mockReturnValue({ where: updateWhere });
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const selectLimit = vi.fn().mockResolvedValue(peer ? [peer] : []);
  const selectFor = vi.fn().mockReturnValue({ limit: selectLimit });
  const selectWhere = vi.fn().mockReturnValue({ for: selectFor });
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  const tx = {
    query: {
      federatedPeer: { findFirst: vi.fn().mockResolvedValue(peer) },
      federatedPeerReset: { findFirst: vi.fn().mockResolvedValue(reset) },
    },
    update: vi.fn().mockReturnValue({ set: updateSet }),
    select: vi.fn().mockReturnValue({ from: selectFrom }),
    insert: vi.fn().mockReturnValue({
      values: insertValues,
    }),
  };
  const database = {
    db: {
      query: {
        federatedPeer: { findFirst: vi.fn().mockResolvedValue(peer) },
      },
      transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
    },
  };
  const keypair = {
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

  it('signs the init startChangeId and requires it only for /init claims', () => {
    const { service, publicKey } = makeService();
    const signed = service.signClaim(
      service.createClaim('peer.example', 'n'.repeat(24), 42n),
    );
    expect(
      service.validateClaim(signed, 'local.example', 'peer.example', true)
        .startChangeId,
    ).toBe('42');

    expect(() =>
      service.validateClaim(
        service.createClaim('peer.example', 'n'.repeat(24)),
        'local.example',
        'peer.example',
        true,
      ),
    ).toThrow(BusinessException);

    expect(() =>
      service.verifySignedClaim(
        { ...signed, startChangeId: '43' },
        'local.example',
        'peer.example',
        'n'.repeat(24),
        publicKey,
      ),
    ).toThrow(BusinessException);
  });

  it('rejects stale identity claims', () => {
    const { service } = makeService();
    const claim = service.createClaim('peer.example', 'n'.repeat(24));
    claim.issuedAt = Date.now() - 6 * 60_000;
    expect(() =>
      service.validateClaim(claim, 'local.example', 'peer.example'),
    ).toThrow(BusinessException);
  });

  it('rejects the former ISO-string identity timestamp representation', () => {
    const { service } = makeService();
    const claim = service.createClaim('peer.example', 'n'.repeat(24));
    expect(() =>
      service.validateClaim(
        { ...claim, issuedAt: new Date(claim.issuedAt).toISOString() },
        'local.example',
        'peer.example',
      ),
    ).toThrow(BusinessException);
  });

  it('serves proof to an identity-lost peer without treating blocked peers as recoverable', async () => {
    await expect(
      makeService({
        trustLevel: 'identity_lost',
      }).service.requireIdentityEndpointPeer('peer.example'),
    ).resolves.toBeUndefined();

    await expect(
      makeService({
        trustLevel: 'blocked',
      }).service.requireIdentityEndpointPeer('peer.example'),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PEER_NOT_TRUSTED,
    });
  });

  it('commits identity_lost before returning the mismatch error', async () => {
    const { service, updateSet, insertValues } = makeService({
      domain: 'peer.example',
      trustLevel: 'trusted',
      identityPinnedAt: new Date(),
      pairwiseServerId: 'old',
      rootKeyFingerprint: `sha256:${'C'.repeat(43)}`,
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

  it('refuses first contact from a reset domain without an explicit rejoin grant', async () => {
    const { service } = makeService(undefined, {
      domain: 'peer.example',
      resetGeneration: 1,
      reinitPending: false,
    });
    const claim = service.createClaim('local.example', 'n'.repeat(24));
    claim.originDomain = 'peer.example';
    claim.recipientDomain = 'local.example';

    await expect(
      service.pinOrVerify('peer.example', claim),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PEER_IDENTITY_LOST,
    });
  });

  it('consumes the reset-completion rejoin grant after pinning the new identity', async () => {
    const { service, updateSet } = makeService(undefined, {
      domain: 'peer.example',
      resetGeneration: 1,
      reinitPending: true,
    });
    const claim = service.createClaim('local.example', 'n'.repeat(24));
    claim.originDomain = 'peer.example';
    claim.recipientDomain = 'local.example';

    await service.pinOrVerify('peer.example', claim);

    expect(updateSet).toHaveBeenCalledWith({ reinitPending: false });
  });
});
