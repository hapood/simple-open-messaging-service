import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  ed25519PublicKeyToX25519,
  ed25519SecretKeyToX25519,
  openSealedBox,
  sealBox,
} from './sealed-box.js';

/** Public test seed `AAECAwQ…` (bytes 0..31) used across the federation specs. */
const TEST_SEED = Uint8Array.from(
  Buffer.from('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', 'base64'),
);

describe('sealed-box primitive', () => {
  it('converts Ed25519 keys exactly like libsodium', () => {
    // Generated with system libsodium crypto_sign_ed25519_pk_to_curve25519 /
    // sk_to_curve25519 for the public test seed.
    expect(
      Buffer.from(
        ed25519PublicKeyToX25519(ed25519.getPublicKey(TEST_SEED)),
      ).toString('hex'),
    ).toBe('4701d08488451f545a409fb58ae3e58581ca40ac3f7f114698cd71deac73ca01');
    expect(
      Buffer.from(ed25519SecretKeyToX25519(TEST_SEED)).toString('hex'),
    ).toBe('3894eea49c580aef816935762be049559d6d1440dede12e6a125f1841fff8e6f');
  });

  it('opens real libsodium crypto_box_seal output', () => {
    // System libsodium sealed these plaintexts under the public test key with
    // random ephemeral keys; our construction must open them exactly.
    const vectors: Array<[string, string | null]> = [
      [
        'TZR17XSDeQKRL42YBNMzjR/6ocbatcIQjok9OMaQWnDFMMgvoHwdBWAm86FWCiXc5BqRebqicMfDTaCzRNNXFS3gUTYujHgYhD8tjbXfpQySC9OLwjuZxQ==',
        '{"account":"alice","domain":"a.example"}',
      ],
      [
        'j+7KHU7gllK/j7gRWOMEA5DgSzntWJsY0Zn28SeT4ELO1oYJymHydGb5qa0qTSP4gsv/gMlwJJIxh+sHkLbqDu8Z+Q==',
        'sealed by libsodium',
      ],
      [
        '8w2MAp/4SgVIOCGBTbtiv6OAffzc9kC0B6iQLQcp/ifmJwqF5YDKUGi7ebQBJ3iuJQ0kO9Hm4kLMKjZ/WfYgaXlULr9OMyJXoCy6rneQYjadTnRQOgFG1yNy0ZbfBqnZkdWC0SX5Y1PH9M/eX4axt9SJinlPKHshsth7HmmN5EiwWArcyY4kF8dxWsm3TbKwDa5jr+kxGysJe3NV4ZfajSGNc4v05UjtDekGGlxPG7det3UYoqfY7V0gxW2nspz9GmBfNb9tnNFBaf/9Ov1DLADNbLpBexGYZfKlFdWxsOvzUBAjWFWBuahkWv+kK2d3ssUONT7O2ezambCNaS5a3eIflodOjLNZ2ZnaXaT/aOOj5bdLdGWaGgYZTM9mmO3bE4CFbCmGKPpEkIiA1bHEjQ==',
        null,
      ],
    ];
    for (const [encoded, expected] of vectors) {
      const sealed = Buffer.from(encoded, 'base64');
      const opened = openSealedBox(sealed, TEST_SEED)!;
      expect(Buffer.from(opened)).toEqual(
        expected === null
          ? Buffer.from([...Array(256).keys()])
          : Buffer.from(expected, 'utf8'),
      );
    }
  });

  it('round-trips arbitrary opaque plaintext', () => {
    const plaintext = Buffer.from('arbitrary \0 opaque bytes', 'utf8');
    const sealed = sealBox(plaintext, ed25519.getPublicKey(TEST_SEED));
    expect(Buffer.from(openSealedBox(sealed, TEST_SEED)!)).toEqual(plaintext);
  });

  it('rejects tampered and truncated boxes', () => {
    const sealed = sealBox(
      Buffer.from('proof'),
      ed25519.getPublicKey(TEST_SEED),
    );
    const flipped = Uint8Array.from(sealed);
    flipped[40]! ^= 0x01;
    expect(openSealedBox(flipped, TEST_SEED)).toBeNull();
    expect(
      openSealedBox(sealed.subarray(0, sealed.length - 1), TEST_SEED),
    ).toBeNull();
    expect(openSealedBox(sealed.subarray(0, 47), TEST_SEED)).toBeNull();
  });

  it('does not open under a different key', () => {
    const sealed = sealBox(
      Buffer.from('proof'),
      ed25519.getPublicKey(TEST_SEED),
    );
    const otherSeed = ed25519.utils.randomSecretKey();
    expect(openSealedBox(sealed, otherSeed)).toBeNull();
    // A genuine libsodium box sealed under a different recipient key.
    const foreign = Buffer.from(
      'G7R+mzBN7PRfzTIjBITZKOsDz+uZgCDiBbYgkVwxrUT7uYyu0cNtEloMriF0r3e0PN6rsteJ',
      'base64',
    );
    expect(openSealedBox(foreign, TEST_SEED)).toBeNull();
  });
});
