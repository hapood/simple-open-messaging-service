import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020Module from 'ajv/dist/2020.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { KeypairService } from './keypair.service.js';
import { sealBox } from './sealed-box.js';
import { S2sVerifyController } from './s2s-verify.controller.js';

const secret = new Uint8Array(32).fill(7);
const publicKey = ed25519.getPublicKey(secret);
const publicKeyB64 = Buffer.from(publicKey).toString('base64');
const keys = {
  getRetainedPrivateKey: () => secret,
} as unknown as KeypairService;

const ajv = new Ajv2020Module.default({ strict: false });
for (const name of ['common', 'identity', 'profile']) {
  ajv.addSchema(
    JSON.parse(
      readFileSync(
        join(process.cwd(), 'spec/v1/schema', `${name}.schema.json`),
        'utf8',
      ),
    ),
  );
}
const validateAnswer = ajv.getSchema(
  'urn:somfp:v1:common#/$defs/base64ChallengeAnswer',
)!;
const validateVerify = ajv.getSchema(
  'urn:somfp:v1:identity#/$defs/verifyResult',
)!;
const validateProfile = ajv.getSchema('urn:somfp:v1:profile')!;
const profile = {
  account: 'alice',
  generatedAt: 1700000000000,
  profileRev: 1,
  profile: { displayName: 'Alice', bio: '', avatar: null },
};

for (const endpoint of ['verify', 'profile'] as const) {
  describe(`${endpoint} challenge answer bytes`, () => {
    async function answer(plaintext: Buffer): Promise<string> {
      const box = Buffer.from(sealBox(plaintext, publicKey)).toString('base64');
      if (endpoint === 'profile') {
        return KeypairService.prototype.openCardChallenge.call(
          keys,
          publicKeyB64,
          box,
        );
      }
      return (
        await new S2sVerifyController(keys).verify({
          publicKey: publicKeyB64,
          encryptedValue: box,
        })
      ).value;
    }

    it.each([
      Buffer.alloc(0),
      Buffer.from([0, 255, 128, 192, 175, 237, 160, 128]),
      Buffer.from('hello\u0000世界'),
      Buffer.alloc(4096, 255),
    ])(
      'round-trips opaque bytes without UTF-8 replacement (%#)',
      async (bytes) => {
        const result = await answer(bytes);
        expect(result).toBe(bytes.toString('base64'));
        expect(Buffer.from(result, 'base64')).toEqual(bytes);
        expect(validateVerify({ value: result })).toBe(true);
        expect(validateProfile({ ...profile, proof: result })).toBe(true);
      },
    );

    it('rejects plaintext above the byte limit', async () => {
      await expect(answer(Buffer.alloc(4097))).rejects.toMatchObject({
        bizCode: BusinessCode.FEDERATION_MALFORMED,
      });
    });
  });
}

describe('challenge answer schema', () => {
  it('accepts every allowed byte length and rejects 4097/4098 despite equal encoded length', () => {
    for (let length = 0; length <= 4098; length++) {
      expect(
        validateAnswer(Buffer.alloc(length, 255).toString('base64')),
        `length ${length}`,
      ).toBe(length <= 4096);
    }
  });

  it.each([
    'hello',
    'Zg',
    'Zh==',
    'Zm9=',
    'Zg===',
    '_w==',
    'Zg==\n',
    ' Zg==',
    '😀',
  ])('rejects noncanonical or legacy answers: %j', (value) => {
    expect(validateVerify({ value })).toBe(false);
    expect(validateProfile({ ...profile, proof: value })).toBe(false);
  });
});
