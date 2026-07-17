import { createHash } from 'node:crypto';
import { resolvePersistentSecret } from './jwt-secret.js';

/**
 * The pepper folded into every user/admin password hash via Argon2's spec'd secret parameter (K).
 * Resolved ONCE at module load from SOMS_PASSWORD_PEPPER (env) → ./data/password-pepper.key (prior first
 * boot) → auto-generated, exactly like the admin JWT signing secret and the 2FA at-rest key. The resolved
 * string is the *key material*; the actual 32-byte pepper is SHA-256(key material) so any strong env
 * value yields a valid 32-byte secret regardless of its encoding, and rotating SOMS_PASSWORD_PEPPER
 * rekeys every password hash (existing hashes stop verifying → every user must reset, the correct
 * outcome of a pepper rotation: a pepper can NEVER be silently changed while keeping logins working).
 *
 * Why a SEPARATE key from the 2FA key (src/admin/two-factor.secret.ts), not a reuse: key-per-purpose. The
 * 2FA key encrypts TOTP secrets + blinds backup codes (all "2FA at-rest protection"); the password pepper
 * defends password hashes. Keeping them distinct means a rotation or compromise of one never cascades into
 * the other — rotating the 2FA key (admins re-enroll) does NOT invalidate every password, and rotating the
 * pepper (everyone resets password) does NOT break existing 2FA. The cost is one extra auto-generated
 * secret file under ./data, which is the right trade for isolation.
 *
 * Why pepper at all (OWASP password storage): Argon2id is the slow KDF that defeats offline guessing of the
 * (low-entropy, user-chosen) password; the pepper is the server-side secret that means a DATABASE leak
 * ALONE cannot mount an offline attack — the attacker also needs this key, which lives in env/./data, never
 * in the DB. Without the pepper, argon2.verify against a dumped hash is impossible. (High-entropy
 * server-generated tokens — backup codes — instead use a fast HMAC keyed by the 2FA key; the slow KDF is
 * pointless there. See src/admin/two-factor.service.ts.)
 */
const PASSWORD_PEPPER_MATERIAL = resolvePersistentSecret('SOMS_PASSWORD_PEPPER', 'password-pepper.key');

export const passwordPepper: Buffer = createHash('sha256').update(PASSWORD_PEPPER_MATERIAL).digest();
