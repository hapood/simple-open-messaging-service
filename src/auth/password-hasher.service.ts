import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { passwordPepper } from './password-pepper.secret.js';

/**
 * Argon2id parameters — the OWASP password-storage "first category" baseline
 * (https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): m=19456 (19 MiB),
 * t=2, p=1, hashLength=32. Fixed and explicit (NOT relying on the binding's defaults) so the cost is
 * documented at the call site and a future change is an intentional edit here, not a silent library bump.
 *
 * The pepper ({@link passwordPepper}) is supplied as Argon2's spec'd `secret` (K) parameter — integrated
 * into the KDF itself, the academically-correct pepper construction (stronger than prepending the pepper
 * to the password, which Argon2 explicitly warns against). argon2.verify must be passed the SAME secret to
 * match; a hash produced with the pepper cannot be verified without it.
 */
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB — OWASP first-category baseline
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
  secret: passwordPepper,
};

/**
 * The single home for user/admin PASSWORD hashing. Every site that stores or checks a password goes
 * through here, so the Argon2 parameters + the pepper are controlled in one place (previously each login
 * path called argon2.hash/argon2.verify directly with the binding defaults and no pepper).
 *
 * Scope: PASSWORDS only — low-entropy, user-chosen secrets that need the slow KDF + a pepper. This is NOT
 * used for server-generated tokens: backup codes are high-entropy and HMAC-blinded (see
 * src/admin/two-factor.service.ts); OTP login codes are low-entropy server tokens protected by argon2's
 * raw KDF (see src/auth/otp-login.service.ts). Different threat models, different primitives, deliberately
 * not unified.
 *
 * Every stored hash is peppered, produced by {@link hash}, and
 * verified by {@link verify} with the same pepper; if the pepper ever changes, all hashes are invalidated
 * by design (users reset) — there is no migration shim.
 */
@Injectable()
export class PasswordHasher {
  /** Hash a plaintext password → Argon2id encoded string (pepper folded in via the secret parameter). */
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, HASH_OPTIONS);
  }

  /** Verify a plaintext password against a stored Argon2id encoded string. False on any mismatch. */
  verify(stored: string, plain: string): Promise<boolean> {
    return argon2.verify(stored, plain, { secret: passwordPepper });
  }
}
