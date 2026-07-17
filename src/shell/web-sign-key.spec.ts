import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Cross-half consistency of the web-bundle signing contract.
 *
 * The bundle is signed server-side (scripts/sign-web-bundle.mjs, @noble/curves Ed25519) and verified
 * shell-side (src-tauri/src/lib.rs init_download_web, ed25519-dalek verify_strict) against a pubkey
 * pinned in the shell. A keypair drift between the two halves would make EVERY bundle fail signature
 * verification (or, worse, accept bundles signed by the wrong key). These tests pin the TS/signer half of
 * the contract against the EXACT bytes baked into Rust, so a change to either side is caught here without
 * needing the Rust toolchain:
 *   - the DEV pubkey derived from the signer's DEV seed must equal the 32 bytes in Rust DEV_WEB_PUBKEY;
 *   - a signature produced the way the signer produces it (ed25519.sign over the full bundle bytes) must
 *     verify against that pubkey.
 *
 * The noble↔dalek cross-library interop itself is guaranteed by RFC 8032 (standard Ed25519) and is
 * compile-checked by `cargo check`; it is exercised end-to-end only at the device build.
 */

// MUST stay in lock-step with src-tauri/src/lib.rs DEV_WEB_PUBKEY (the dev fallback) and the
// 'soms-dev-web-signing-key-v1' marker in scripts/sign-web-bundle.mjs. If you change either, update both
// + this constant together.
const RUST_BAKED_DEV_PUBKEY_HEX = '611970fd7628b0ebfaccdaf88b6493c8f57207822c248c98e3bd47306a1f86c3';
const DEV_SEED = createHash('sha256').update('soms-dev-web-signing-key-v1').digest(); // 32 bytes

describe('web-bundle signing key consistency (signer ↔ shell)', () => {
  it('the dev pubkey derived from the signer seed matches the bytes baked in Rust DEV_WEB_PUBKEY', () => {
    const derived = Buffer.from(ed25519.getPublicKey(DEV_SEED)).toString('hex');
    expect(derived).toBe(RUST_BAKED_DEV_PUBKEY_HEX);
  });

  it('a bundle signed with the dev seed verifies against the baked dev pubkey (the install-time check)', () => {
    // Mirrors scripts/sign-web-bundle.mjs (sign full bytes) + init_download_web (verify against WEB_PUBKEY).
    const bytes = Buffer.from('fake-web-bundle-tar-bytes');
    const sig = ed25519.sign(bytes, DEV_SEED);
    const pub = ed25519.getPublicKey(DEV_SEED);
    expect(ed25519.verify(sig, bytes, pub)).toBe(true);
    // And the pubkey is exactly the Rust-baked one (not some other key this signed under).
    expect(Buffer.from(pub).toString('hex')).toBe(RUST_BAKED_DEV_PUBKEY_HEX);
  });

  it('a signature over DIFFERENT bytes does not verify (tamper detection)', () => {
    const sig = ed25519.sign(Buffer.from('original-bytes'), DEV_SEED);
    const pub = ed25519.getPublicKey(DEV_SEED);
    expect(ed25519.verify(sig, Buffer.from('tampered-bytes'), pub)).toBe(false);
  });

  it('a signature from a DIFFERENT seed does not verify against the baked pubkey (wrong-key rejection)', () => {
    const otherSeed = createHash('sha256').update('not-the-dev-seed').digest();
    const bytes = Buffer.from('some-bytes');
    const sig = ed25519.sign(bytes, otherSeed);
    const bakedPub = ed25519.getPublicKey(DEV_SEED);
    expect(ed25519.verify(sig, bytes, bakedPub)).toBe(false);
  });
});
