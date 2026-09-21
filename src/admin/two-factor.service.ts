import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { and, count, eq, isNull, lt } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  admin,
  adminLoginChallenge,
  twoFactorBackupCode,
} from '../database/schema.js';
import { jwtConstants } from '../auth/constants.js';
import { twoFactorKey } from './two-factor.secret.js';

/** Authenticator display issuer (shown above the account in Google/Microsoft Authenticator). */
const TOTP_ISSUER = 'SOMS Admin';
/** TOTP parameters per RFC 6238 — the universal authenticator defaults (Google/Microsoft/Aegis/1Password). */
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
/** Acceptance window: the code from the previous, current, and next 30s step are all valid (covers clock
 *  drift between the server and the user's phone — the standard authenticator tolerance). */
const TOTP_WINDOW = 1;
/** AES-256-GCM: 12-byte IV (GCM recommended) + 16-byte auth tag, stored prepended to the ciphertext. */
const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;

/** TTL of a login challenge token — the window the admin has to type their 6-digit code after a correct
 *  password. Short on purpose: the token is the only proof password was verified, so it must not live long. */
const CHALLENGE_TTL = '5m' as const;
/** TTL of a setup pending token — the window to scan the QR and confirm the first code. Carries the
 *  candidate secret (which is also shown in the QR/manual key, so signing-not-encrypting is fine). */
const PENDING_TTL = '10m' as const;

/** How many backup (recovery) codes to mint per enable/regenerate. */
const BACKUP_CODE_COUNT = 10;
/** Backup-code entropy: 16 base32 chars = 80 bits. The twoFactorKey (the HMAC key / pepper) is the primary
 *  defense — a DB leak alone cannot brute-force codes — and 80 bits keeps offline brute-force infeasible
 *  even in the worst case where both DB and key leak. (Passwords, by contrast, are low-entropy and
 *  user-chosen, so they use the slow Argon2id KDF + a separate pepper in PasswordHasher.) */
const BACKUP_CODE_CHARS = 16;

/** The result of a TOTP check against a candidate secret. */
export interface TotpCheck {
  ok: boolean;
  /** On success, the TOTP step counter (⌊t/30s⌋) that was accepted — persist as lastUsed to block replay. */
  counter?: number;
}

/** A setup bundle returned to the authenticated admin to enroll their authenticator (stateless pending). */
export interface SetupBundle {
  /** `otpauth://totp/...` provisioning URI — the frontend renders it as a QR. */
  otpauthUri: string;
  /** Base32 secret for manual entry (shown alongside the QR for devices without a camera). */
  secret: string;
  /** Short-lived signed token carrying the candidate secret; submit it back with the first code to enroll. */
  pendingToken: string;
}

/** Verified pending-setup token payload. */
export interface PendingPayload {
  adminId: number;
  secret: string;
}

/**
 * Admin TOTP two-factor core: pure crypto + the TwoFactorBackupCode / Admin.twoFactor* storage. Has NO
 * dependency on AdminAuthService (the orchestrator owns token issuance + brute-force), so there is no
 * circular DI — AdminAuthService injects THIS, never the reverse (ESM + emitDecoratorMetadata would TDZ
 * on a cycle, see the esm-circular-di-tdz note).
 *
 * Secrets are AES-256-GCM encrypted at rest under {@link twoFactorKey}; only the base32 plaintext leaves
 * the server, ONCE, during enrollment (in the QR + manual key + the signed pending token). Backup codes
 * are high-entropy (80-bit) server-generated tokens, so they are stored as HMAC-SHA256(code) keyed by the
 * SAME twoFactorKey — a deterministic blind that enables a single O(1) indexed lookup at consume time and
 * means a DB leak alone cannot recover any code (the key lives in env/./data, never the DB). Single-use is
 * enforced by an updateMany(consumedAt IS NULL) guard (mirrors LoginCode).
 */
@Injectable()
export class TwoFactorService {
  constructor(
    private readonly database: DatabaseService,
    private readonly jwtService: JwtService,
  ) {}

  // ── TOTP core ─────────────────────────────────────────────────────────────────

  /** Build the provisioning URI + a fresh random 160-bit secret, and sign a pending token carrying it. */
  beginSetup(adminId: number, account: string, name: string): SetupBundle {
    void name;
    const secret = new Secret({ size: 20 }); // 160 bits — RFC 4226 §4 recommends ≥160
    const base32 = secret.base32;
    const totp = this.totp(base32, account);
    const pendingToken = this.jwtService.sign(
      { sub: adminId, scope: '2fa-setup-pending', sec: base32 },
      { secret: jwtConstants.adminSecret, expiresIn: PENDING_TTL },
    );
    return { otpauthUri: totp.toString(), secret: base32, pendingToken };
  }

  /** Verify a TOTP against a base32 secret, enforcing the same-window replay guard. */
  verifyTotp(
    secretBase32: string,
    token: string,
    lastUsedCounter: number | null,
  ): TotpCheck {
    const totp = this.totp(secretBase32);
    const delta = totp.validate({ token, window: TOTP_WINDOW });
    if (delta === null) return { ok: false };
    const counter = Math.floor(Date.now() / (TOTP_PERIOD * 1000)) + delta;
    // Reject a code from a step already consumed (RFC 6238 §5.2 — the same 30s code can't be used twice).
    if (lastUsedCounter !== null && counter <= lastUsedCounter)
      return { ok: false };
    return { ok: true, counter };
  }

  private totp(secretBase32: string, label?: string): TOTP {
    return new TOTP({
      issuer: TOTP_ISSUER,
      label: label ?? TOTP_ISSUER,
      algorithm: 'SHA1', // the algorithm every authenticator supports; SHA1 here is HMAC-SHA1 (no collision concern)
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
      secret: Secret.fromBase32(secretBase32),
    });
  }

  // ── at-rest secret encryption (AES-256-GCM) ────────────────────────────────────

  private encrypt(plaintext: string): string {
    const iv = randomBytes(GCM_IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', twoFactorKey, iv);
    const enc = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  private decrypt(b64: string): string {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, GCM_IV_LEN);
    const tag = buf.subarray(GCM_IV_LEN, GCM_IV_LEN + GCM_TAG_LEN);
    const enc = buf.subarray(GCM_IV_LEN + GCM_TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', twoFactorKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
      'utf8',
    );
  }

  /** Decrypt an admin's stored secret cipher → base32 plaintext (throws on tamper / wrong key). */
  decryptSecret(twoFactorSecretCipher: string): string {
    return this.decrypt(twoFactorSecretCipher);
  }

  // ── pending setup + login challenge tokens (signed with the admin secret, distinct scope) ───────

  /** Decode a setup pending token. Returns null on any failure (invalid / expired / wrong scope). */
  verifyPending(token: string): PendingPayload | null {
    try {
      const payload = this.jwtService.verify<{
        sub?: number;
        scope?: string;
        sec?: string;
      }>(token, {
        secret: jwtConstants.adminSecret,
      });
      if (
        payload.scope !== '2fa-setup-pending' ||
        typeof payload.sub !== 'number' ||
        !payload.sec
      ) {
        return null;
      }
      return { adminId: payload.sub, secret: payload.sec };
    } catch {
      return null;
    }
  }

  /** Sign a login challenge token — the only credential that proves the password already verified. The
   *  token carries a single-use `jti`; a matching AdminLoginChallenge row is minted here and flipped to
   *  consumed on the first successful second-factor verify (see {@link consumeChallenge}), so a captured
   *  challenge cannot be replayed for a second session — closes the counter=0 passkey replay window that
   *  TOTP already covered via twoFactorLastUsedCounter. Also lazily GCs expired rows to bound the table. */
  async signChallenge(adminId: number): Promise<string> {
    const jti = randomUUID();
    // Best-effort GC: drop rows older than 1h (the challenge TTL is 5m, so these are long-expired).
    await this.database.db
      .delete(adminLoginChallenge)
      .where(
        lt(
          adminLoginChallenge.createdAt,
          new Date(Date.now() - 60 * 60 * 1000),
        ),
      )
      .catch(() => {});
    await this.database.db.insert(adminLoginChallenge).values({ jti, adminId });
    return this.jwtService.sign(
      { sub: adminId, scope: 'admin-2fa-challenge', jti },
      { secret: jwtConstants.adminSecret, expiresIn: CHALLENGE_TTL },
    );
  }

  /** Decode a login challenge token → { adminId, jti }. Returns null on any failure (invalid / expired /
   *  wrong scope). The jti is what {@link consumeChallenge} marks single-use. */
  verifyChallenge(token: string): { adminId: number; jti: string } | null {
    try {
      const payload = this.jwtService.verify<{
        sub?: number;
        scope?: string;
        jti?: string;
      }>(token, {
        secret: jwtConstants.adminSecret,
      });
      if (
        payload.scope !== 'admin-2fa-challenge' ||
        typeof payload.sub !== 'number' ||
        typeof payload.jti !== 'string'
      ) {
        return null;
      }
      return { adminId: payload.sub, jti: payload.jti };
    } catch {
      return null;
    }
  }

  /** Atomically consume a challenge's single-use slot. Returns true iff THIS call was the first to flip
   *  consumedAt from null — a second consume (a replay, or a cross-factor reuse of the same challenge)
   *  returns false and the caller rejects it. Called by AdminAuthService on a successful TOTP/backup OR
   *  passkey verify, after the factor is proven but before the session is issued. */
  async consumeChallenge(jti: string): Promise<boolean> {
    const rows = await this.database.db
      .update(adminLoginChallenge)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(adminLoginChallenge.jti, jti),
          isNull(adminLoginChallenge.consumedAt),
        ),
      )
      .returning({ jti: adminLoginChallenge.jti });
    return rows.length > 0;
  }

  // ── Admin.twoFactor* + TwoFactorBackupCode persistence ──────────────────────────

  /** Atomically enable 2FA: persist the encrypted secret + flags and replace backup codes in one
   *  transaction, so the moment `twoFactorEnabled` is observable as true the enrollment write is
   *  complete. The caller (AdminAuthService.completeSetup) then revokes every outstanding admin
   *  session (revokeSessionsByAdmin '2fa_enabled'), so no pre-enrollment session can bypass the new
   *  factor — the admin re-logs in through the 2FA challenge. Returns the plaintext backup codes ONCE. */
  async enableWithBackupCodes(
    adminId: number,
    secretBase32: string,
  ): Promise<{ backupCodes: string[] }> {
    const cipher = this.encrypt(secretBase32);
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, () =>
      generateBackupCode(),
    );
    await this.database.db.transaction(async (tx) => {
      await tx
        .update(admin)
        .set({
          twoFactorEnabled: true,
          twoFactorSecretCipher: cipher,
          twoFactorEnabledAt: new Date(),
          twoFactorLastUsedCounter: null,
          updatedAt: new Date(),
        })
        .where(eq(admin.id, adminId));
      await tx
        .delete(twoFactorBackupCode)
        .where(eq(twoFactorBackupCode.adminId, adminId));
      await tx
        .insert(twoFactorBackupCode)
        .values(codes.map((c) => ({ adminId, codeHash: hashBackupCode(c) })));
    });
    return { backupCodes: codes.map(formatBackupCode) };
  }

  /** Atomically disable 2FA: clear the secret + flags and drop all backup codes. */
  async disable(adminId: number): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx
        .update(admin)
        .set({
          twoFactorEnabled: false,
          twoFactorSecretCipher: null,
          twoFactorEnabledAt: null,
          twoFactorLastUsedCounter: null,
          updatedAt: new Date(),
        })
        .where(eq(admin.id, adminId));
      await tx
        .delete(twoFactorBackupCode)
        .where(eq(twoFactorBackupCode.adminId, adminId));
    });
  }

  /** Replace all backup codes with a fresh set (requires a fresh TOTP at the call site). Returns plaintext ONCE. */
  async regenerateBackupCodes(
    adminId: number,
  ): Promise<{ backupCodes: string[] }> {
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, () =>
      generateBackupCode(),
    );
    await this.database.db.transaction(async (tx) => {
      await tx
        .delete(twoFactorBackupCode)
        .where(eq(twoFactorBackupCode.adminId, adminId));
      await tx
        .insert(twoFactorBackupCode)
        .values(codes.map((c) => ({ adminId, codeHash: hashBackupCode(c) })));
    });
    return { backupCodes: codes.map(formatBackupCode) };
  }

  /** Try to consume one backup code. The stored value is an HMAC (deterministic), so a single indexed
   *  lookup by (adminId, codeHash) finds the match in O(1) — no verify loop. Single-use is enforced by an
   *  updateMany(consumedAt IS NULL) guard: only the first concurrent verifier wins. Returns false if the
   *  code is unknown/malformed or a concurrent verifier already consumed it. */
  async consumeBackupCode(adminId: number, rawCode: string): Promise<boolean> {
    const code = normalizeBackupCode(rawCode);
    if (!code) return false;
    const row = await this.database.db.query.twoFactorBackupCode.findFirst({
      where: and(
        eq(twoFactorBackupCode.adminId, adminId),
        eq(twoFactorBackupCode.codeHash, hashBackupCode(code)),
        isNull(twoFactorBackupCode.consumedAt),
      ),
      columns: { id: true },
    });
    if (!row) return false;
    const claimed = await this.database.db
      .update(twoFactorBackupCode)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(twoFactorBackupCode.id, row.id),
          isNull(twoFactorBackupCode.consumedAt),
        ),
      )
      .returning({ id: twoFactorBackupCode.id });
    return claimed.length > 0; // false only if a concurrent verifier beat us to it
  }

  /** Remaining (unconsumed) backup codes — for the status card's "X codes left" indicator. */
  async remainingBackupCodes(adminId: number): Promise<number> {
    return this.database.db
      .select({ value: count() })
      .from(twoFactorBackupCode)
      .where(
        and(
          eq(twoFactorBackupCode.adminId, adminId),
          isNull(twoFactorBackupCode.consumedAt),
        ),
      )
      .then(([row]) => row.value);
  }
}

/** RFC 4648 base32 alphabet — unambiguous (no 0/1/O/I), the canonical authenticator encoding. */
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Mint one backup code as its 16-char BARE canonical form (uppercase base32, no dashes) from 16 random
 *  bytes (32 | 256 → no modulo bias). The dashed DISPLAY form is produced by {@link formatBackupCode};
 *  the HMAC is always taken over the bare form (see {@link hashBackupCode}), so a typed code in any
 *  case/dash spacing normalizes back to the same canonical input. */
function generateBackupCode(): string {
  const bytes = randomBytes(BACKUP_CODE_CHARS);
  let chars = '';
  for (let i = 0; i < BACKUP_CODE_CHARS; i++)
    chars += CODE_ALPHABET[bytes[i] % 32];
  return chars;
}

/** Render a bare backup code as the human-typeable `XXXX-XXXX-XXXX-XXXX` display form (shown ONCE). */
function formatBackupCode(bare: string): string {
  return `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8, 12)}-${bare.slice(12)}`;
}

/** Normalize a typed backup code to its BARE canonical form: uppercase, strip everything but [A-Z2-7],
 *  require exactly {@link BACKUP_CODE_CHARS} characters. Returns null if the input is malformed (no lookup
 *  is attempted in that case). */
function normalizeBackupCode(raw: string): string | null {
  const cleaned = raw.toUpperCase().replace(/[^A-Z2-7]/g, '');
  return cleaned.length === BACKUP_CODE_CHARS ? cleaned : null;
}

/** The deterministic blind stored for each backup code: HMAC-SHA256 over the BARE code, keyed by the 2FA
 *  at-rest key. Exported so tests can seed a store with the exact stored value; the key stays
 *  module-private, so the exported digest is never usable off-server. */
export function hashBackupCode(bareCode: string): string {
  return createHmac('sha256', twoFactorKey)
    .update(bareCode)
    .digest('base64url');
}
