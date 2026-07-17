import { createHash } from 'node:crypto';
import { resolvePersistentSecret } from '../auth/jwt-secret.js';

/**
 * The AES-256-GCM key that encrypts admin TOTP secrets at rest. Resolved ONCE at module load from
 * SOMS_2FA_KEY (env) → ./data/2fa.key (prior first boot) → auto-generated, exactly like the admin JWT
 * signing secret (src/auth/jwt-secret.ts). The resolved string is the *key material*; the actual
 * 32-byte AES key is SHA-256(key material) so any strong env value yields a valid 32-byte key regardless
 * of its encoding, and rotating SOMS_2FA_KEY rekeys the cipher (existing ciphertexts become
 * undecryptable → affected admins must re-enroll 2FA, the correct outcome of a key rotation).
 *
 * Why encrypt TOTP secrets at all (unlike, say, a plain config value): the DB is backed up and may be
 * read by operators / leak; a plaintext TOTP secret there would let anyone with DB access generate valid
 * 6-digit codes and bypass the second factor. A key kept OUT of the DB (env/./data) + AES-GCM at rest
 * removes that — an offline DB copy alone cannot mint codes. The IV + auth tag are stored alongside the
 * ciphertext (see TwoFactorService.encryptSecret).
 */
const TWO_FACTOR_KEY_MATERIAL = resolvePersistentSecret('SOMS_2FA_KEY', '2fa.key');

export const twoFactorKey: Buffer = createHash('sha256').update(TWO_FACTOR_KEY_MATERIAL).digest();
