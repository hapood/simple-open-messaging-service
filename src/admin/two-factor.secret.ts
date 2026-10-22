import { createHash } from 'node:crypto';
import { resolveFileSecret } from '../auth/jwt-secret.js';

/**
 * The AES-256-GCM key that encrypts admin TOTP secrets at rest. Resolved ONCE at module load from
 * ./data/2fa.key, or auto-generated there on first boot, exactly like the admin JWT signing secret.
 * The resolved string is the key material; the actual 32-byte AES key is SHA-256(key material).
 *
 * Why encrypt TOTP secrets at all (unlike, say, a plain config value): the DB is backed up and may be
 * read by operators / leak; a plaintext TOTP secret there would let anyone with DB access generate valid
 * 6-digit codes and bypass the second factor. A key kept OUT of the DB (env/./data) + AES-GCM at rest
 * removes that — an offline DB copy alone cannot mint codes. The IV + auth tag are stored alongside the
 * ciphertext (see TwoFactorService.encryptSecret).
 */
const TWO_FACTOR_KEY_MATERIAL = resolveFileSecret('2fa.key');

export const twoFactorKey: Buffer = createHash('sha256')
  .update(TWO_FACTOR_KEY_MATERIAL)
  .digest();
