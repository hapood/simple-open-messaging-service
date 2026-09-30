import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hsalsa, xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import { blake2b } from '@noble/hashes/blake2.js';

/**
 * Sealed-box construction (Federation v1 Transport and Security, Section 3.7):
 * a stateless possession-proof primitive over the X25519 form of the server's
 * Ed25519 keys. Byte-compatible with libsodium's crypto_box_seal, so a
 * challenge produced here opens with crypto_box_seal_open, and a box sealed
 * with libsodium opens here, for any tooling an administrator may use.
 *
 * Wire shape: ephemeral X25519 public key (32 bytes) followed by the
 * XSalsa20-Poly1305 ciphertext including its 16-byte tag. The nonce is
 * BLAKE2b-24 of the ephemeral public key and the recipient public key; the
 * symmetric key is HSalsa20 of the X25519 shared secret keyed with zeros.
 */

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
const ZERO_INPUT = new Uint8Array(16);

const toU32 = (bytes: Uint8Array, words: number): Uint32Array => {
  const out = new Uint32Array(words);
  for (let i = 0; i < words; i += 1) {
    out[i] =
      (bytes[4 * i]! |
        ((bytes[4 * i + 1]! << 8) >>> 0) |
        ((bytes[4 * i + 2]! << 16) >>> 0)) >>>
      0;
    out[i] = (out[i] + bytes[4 * i + 3]! * 0x1000000) >>> 0;
  }
  return out;
};

const fromU32 = (words: Uint32Array): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) {
    out[4 * i] = words[i]! & 0xff;
    out[4 * i + 1] = (words[i]! >>> 8) & 0xff;
    out[4 * i + 2] = (words[i]! >>> 16) & 0xff;
    out[4 * i + 3] = (words[i]! >>> 24) & 0xff;
  }
  return out;
};

/** crypto_core_hsalsa20(out, in16, key32, sigma): the libsodium key-derivation core. */
const hsalsaBytes = (key32: Uint8Array, input16: Uint8Array): Uint8Array => {
  const out = new Uint32Array(8);
  hsalsa(SIGMA, toU32(key32, 8), toU32(input16, 4), out);
  return fromU32(out);
};

/** crypto_box_beforenm: HSalsa20 keyed with the X25519 shared secret, zero input. */
const beforenm = (secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array =>
  hsalsaBytes(x25519.getSharedSecret(secretKey, publicKey), ZERO_INPUT);

const sealNonce = (
  ephemeralPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array =>
  blake2b(new Uint8Array([...ephemeralPublicKey, ...recipientPublicKey]), {
    dkLen: 24,
  });

export const SEALED_BOX_OVERHEAD_BYTES = 48;

/** Convert an Ed25519 public key (root or signing key) to its X25519 form. */
export function ed25519PublicKeyToX25519(
  ed25519PublicKey: Uint8Array,
): Uint8Array {
  return ed25519.utils.toMontgomery(ed25519PublicKey);
}

/** Convert an Ed25519 signing seed to the X25519 private scalar
 *  (libsodium crypto_sign_ed25519_sk_to_curve25519 semantics). */
export function ed25519SecretKeyToX25519(
  ed25519SecretKey: Uint8Array,
): Uint8Array {
  return ed25519.utils.toMontgomerySecret(ed25519SecretKey);
}

/** Seal `plaintext` under `recipientEd25519PublicKey`. Returns
 *  ephemeralPublicKey || xsalsa20poly1305 ciphertext. Throws when the public
 *  key is not a canonical Ed25519 point. */
export function sealBox(
  plaintext: Uint8Array,
  recipientEd25519PublicKey: Uint8Array,
): Uint8Array {
  const recipientX25519 = ed25519PublicKeyToX25519(recipientEd25519PublicKey);
  const ephemeralSecret = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const key = beforenm(ephemeralSecret, recipientX25519);
  const nonce = sealNonce(ephemeralPublic, recipientX25519);
  const ciphertext = xsalsa20poly1305(key, nonce).encrypt(plaintext);
  return new Uint8Array([...ephemeralPublic, ...ciphertext]);
}

/** Open a sealed box with the Ed25519 private key matching the sealing public
 *  key. Returns the recovered plaintext bytes, or null when the box is too
 *  short or fails authentication. The caller owns plaintext interpretation;
 *  this function performs no content validation, per the protocol's opaque
 *  plaintext rule. */
export function openSealedBox(
  sealed: Uint8Array,
  ed25519SecretKey: Uint8Array,
): Uint8Array | null {
  if (sealed.length < SEALED_BOX_OVERHEAD_BYTES) return null;
  const ephemeralPublic = sealed.subarray(0, 32);
  const recipientX25519 = ed25519PublicKeyToX25519(
    ed25519.getPublicKey(ed25519SecretKey),
  );
  try {
    const key = beforenm(
      ed25519SecretKeyToX25519(ed25519SecretKey),
      ephemeralPublic,
    );
    const nonce = sealNonce(ephemeralPublic, recipientX25519);
    return xsalsa20poly1305(key, nonce).decrypt(sealed.subarray(32));
  } catch {
    return null;
  }
}
