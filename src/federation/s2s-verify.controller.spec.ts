import { describe, expect, it, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { ed25519 } from '@noble/curves/ed25519.js';
import { S2sVerifyController } from './s2s-verify.controller.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { sealBox } from './sealed-box.js';

/** A valid 32-byte Ed25519 keypair as base64 strings. */
function keypair() {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    privateKey,
    publicKeyB64: Buffer.from(publicKey).toString('base64'),
  };
}

/** Seals `plaintext` under `publicKey` and returns the base64 box. */
function seal(plaintext: string, publicKey: Uint8Array): string {
  return Buffer.from(
    sealBox(Uint8Array.from(Buffer.from(plaintext, 'utf8')), publicKey),
  ).toString('base64');
}

function controllerWith(privateKey: Uint8Array | null) {
  const keypairService = {
    getRetainedPrivateKey: vi.fn().mockReturnValue(privateKey),
  };
  return {
    controller: new S2sVerifyController(keypairService as never),
    keypairService,
  };
}

describe('S2sVerifyController', () => {
  it('opens a valid sealed challenge and returns the recovered plaintext', async () => {
    const { privateKey, publicKeyB64 } = keypair();
    const publicKey = Uint8Array.from(Buffer.from(publicKeyB64, 'base64'));
    const plaintext = 'canonical-challenge-bytes';
    const { controller } = controllerWith(privateKey);
    const result = await controller.verify({
      publicKey: publicKeyB64,
      encryptedValue: seal(plaintext, publicKey),
    });
    expect(result).toEqual({ value: plaintext });
  });

  it('returns the recovered bytes verbatim without content validation', async () => {
    const { privateKey, publicKeyB64 } = keypair();
    const publicKey = Uint8Array.from(Buffer.from(publicKeyB64, 'base64'));
    // Arbitrary opaque plaintext the oracle must not interpret.
    const plaintext = '{"account":"alice","domain":"peer.test"}';
    const { controller } = controllerWith(privateKey);
    const result = await controller.verify({
      publicKey: publicKeyB64,
      encryptedValue: seal(plaintext, publicKey),
    });
    expect(result.value).toBe(plaintext);
  });

  it.each([
    ['null body', null],
    ['non-object body', 'nope'],
    ['array body', [1, 2]],
  ])('rejects %s with FEDERATION_MALFORMED', async (_label, body) => {
    const { controller } = controllerWith(null);
    await expect(controller.verify(body)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('rejects a body missing required keys', async () => {
    const { controller } = controllerWith(null);
    await expect(controller.verify({ publicKey: 'x' })).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects a body with extra keys', async () => {
    const { privateKey, publicKeyB64 } = keypair();
    const publicKey = Uint8Array.from(Buffer.from(publicKeyB64, 'base64'));
    const { controller } = controllerWith(privateKey);
    await expect(
      controller.verify({
        publicKey: publicKeyB64,
        encryptedValue: seal('hi', publicKey),
        extra: 1,
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects a malformed public key', async () => {
    const { controller } = controllerWith(null);
    await expect(
      controller.verify({
        publicKey: 'not-a-valid-key',
        encryptedValue: 'A'.repeat(48),
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects an encryptedValue shorter than the sealed-box overhead', async () => {
    const { privateKey, publicKeyB64 } = keypair();
    const { controller } = controllerWith(privateKey);
    // 47 base64 chars passes the regex but is below the 48-char minimum.
    await expect(
      controller.verify({
        publicKey: publicKeyB64,
        encryptedValue: 'A'.repeat(47),
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('rejects an unrecognized public key with FEDERATION_PUBLIC_KEY_UNRECOGNIZED', async () => {
    const { publicKeyB64 } = keypair();
    const { controller, keypairService } = controllerWith(null);
    await expect(
      controller.verify({
        publicKey: publicKeyB64,
        encryptedValue: 'A'.repeat(72),
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PUBLIC_KEY_UNRECOGNIZED,
      status: HttpStatus.BAD_REQUEST,
    });
    expect(keypairService.getRetainedPrivateKey).toHaveBeenCalledWith(
      publicKeyB64,
    );
  });

  it('rejects a box that fails to open under the retained key', async () => {
    const { privateKey, publicKeyB64 } = keypair();
    // Seal under a different key, then claim it under the retained one.
    const other = keypair();
    const otherPublic = Uint8Array.from(
      Buffer.from(other.publicKeyB64, 'base64'),
    );
    const { controller } = controllerWith(privateKey);
    await expect(
      controller.verify({
        publicKey: publicKeyB64,
        encryptedValue: seal('challenge', otherPublic),
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });
});
