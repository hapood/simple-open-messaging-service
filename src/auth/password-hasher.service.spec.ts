import { describe, it, expect } from 'vitest';
import argon2 from 'argon2';
import { PasswordHasher } from './password-hasher.service.js';

/**
 * PasswordHasher specs — lock the single property that justifies the service's existence: the pepper is
 * actually folded into the KDF (Argon2's secret parameter), so a hash produced here CANNOT be verified
 * without it. Plus the round-trip, wrong-password, and distinct-salt guarantees. Pure-vitest, real argon2
 * (the pepper is resolved at module load from ./data/password-pepper.key, same as the 2FA key).
 */
describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('round-trip: verify accepts the password that was hashed', async () => {
    const h = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify(h, 'correct horse battery staple')).toBe(true);
  });

  it('verify rejects a wrong password', async () => {
    const h = await hasher.hash('hunter2');
    expect(await hasher.verify(h, 'hunter3')).toBe(false);
    expect(await hasher.verify(h, '')).toBe(false);
  });

  it('distinct salts: the same password hashes to different stored strings', async () => {
    const a = await hasher.hash('same-password');
    const b = await hasher.hash('same-password');
    expect(a).not.toBe(b); // random per-hash salt
    // …yet both verify against the same plaintext.
    expect(await hasher.verify(a, 'same-password')).toBe(true);
    expect(await hasher.verify(b, 'same-password')).toBe(true);
  });

  it('the pepper is folded into the KDF: a hash cannot be verified WITHOUT the secret', async () => {
    // The hash was produced with the pepper (Argon2's secret parameter). Verifying it with raw argon2
    // (no secret) must FAIL — this is the whole point of the pepper: a DB dump alone is useless offline.
    const h = await hasher.hash('secret-password');
    expect(await argon2.verify(h, 'secret-password')).toBe(false);
    // …and the peppered verify succeeds, proving the mismatch is the missing secret, not the password.
    expect(await hasher.verify(h, 'secret-password')).toBe(true);
  });

  it('produces an Argon2id encoded string (the documented algorithm + params)', async () => {
    const h = await hasher.hash('x');
    // Encoded form starts with the argon2id marker and carries the OWASP-baseline params m=19456,t=2,p=1.
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(h).toContain('m=19456');
    expect(h).toContain('t=2');
    expect(h).toContain('p=1');
  });
});
