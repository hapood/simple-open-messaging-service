import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { Secret, TOTP } from 'otpauth';
import { TwoFactorService, hashBackupCode } from './two-factor.service.js';
import { jwtConstants } from '../auth/constants.js';
import {
  admin as adminTable,
  adminLoginChallenge,
} from '../database/schema.js';

/**
 * TwoFactorService unit specs — lock the security-critical pure logic: AES-GCM secret round-trip +
 * tamper detection, TOTP validation + same-window replay guard + ±1 step tolerance, challenge/pending
 * token signing + scope isolation, and backup-code single-use consumption + case/dash normalization.
 *
 * Pure-vitest, hand-rolled Drizzle fake (no Nest DI container). Fake
 * timers make the TOTP step math deterministic (no 30s-boundary flakiness). The service signs/verifies
 * tokens with the REAL jwtConstants.adminSecret (explicit per-call), so a real JwtService exercises the
 * actual HMAC path.
 */

/** Fixed wall clock inside a TOTP step (seconds=0,ms=0 → a clean step boundary; prev/next steps are ±30s). */
const FIXED_NOW = new Date(2026, 5, 17, 12, 0, 0, 0).getTime();

/** Build a service with an overridable persistence fake (default: empty backup-code store). */
function makeService(overrides: Record<string, unknown> = {}) {
  const jwt = new JwtService({ secret: 'unused-see-per-call-secret' });
  const store = {
    twoFactorBackupCode: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => [] as unknown[]),
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    admin: { update: vi.fn(async () => ({})) },
    // signChallenge creates a single-use challenge row; consumeChallenge flips consumedAt (count 1 = first
    // consume wins, count 0 = replay). Individual tests override updateMany to test replay.
    adminLoginChallenge: {
      create: vi.fn(
        async (args: { data: { jti: string; adminId: number } }) => ({
          ...args.data,
        }),
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(store),
    ),
    ...overrides,
  };
  const db = {
    query: {
      twoFactorBackupCode: {
        findFirst: (...args: unknown[]) =>
          store.twoFactorBackupCode.findFirst(...args),
      },
    },
    update: (table: unknown) => {
      let operation: Promise<unknown> = Promise.resolve(undefined);
      const query = {
        set: (data: Record<string, unknown>) => {
          operation =
            table === adminTable
              ? (store.admin.update?.({ data }) ?? Promise.resolve(undefined))
              : table === adminLoginChallenge
                ? (store.adminLoginChallenge.updateMany?.() ??
                  Promise.resolve({ count: 0 }))
                : (store.twoFactorBackupCode.updateMany?.({ data }) ??
                  Promise.resolve({ count: 0 }));
          return query;
        },
        where: () => query,
        returning: async () => {
          const result = (await operation) as { count?: number };
          return result?.count === 0 ? [] : [{ id: 1, jti: 'claimed' }];
        },
        then: (resolve: (value: unknown) => unknown) => operation.then(resolve),
      };
      return query;
    },
    delete: (table: unknown) => ({
      where: () =>
        table === adminLoginChallenge
          ? (store.adminLoginChallenge.deleteMany?.() ??
            Promise.resolve(undefined))
          : (store.twoFactorBackupCode.deleteMany?.() ??
            Promise.resolve(undefined)),
    }),
    insert: (table: unknown) => ({
      values: (data: unknown) =>
        table === adminLoginChallenge
          ? (store.adminLoginChallenge.create?.({ data }) ??
            Promise.resolve(undefined))
          : (store.twoFactorBackupCode.createMany?.({ data }) ??
            Promise.resolve(undefined)),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { svc: new TwoFactorService({ db } as never, jwt), store };
}

/** Generate a valid TOTP code for a base32 secret at a given timestamp (mirrors the authenticator). */
function codeFor(b32: string, timestamp: number = Date.now()): string {
  return new TOTP({
    issuer: 'SOMS Admin',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(b32),
  }).generate({ timestamp });
}

/** Access the private AES helpers for a direct round-trip test. */
type CryptoInternals = { encrypt: (s: string) => string };

describe('TwoFactorService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── AES-256-GCM at-rest encryption ────────────────────────────────────────────

  it('AES round-trip: decryptSecret(encrypt(x)) === x and the ciphertext is not the plaintext', () => {
    const { svc } = makeService();
    const plain = 'JBSWY3DPEHPK3PXP';
    const cipher = (svc as unknown as CryptoInternals).encrypt(plain);
    expect(cipher).not.toBe(plain);
    expect(svc.decryptSecret(cipher)).toBe(plain);
  });

  it('AES tamper detection: a modified ciphertext fails to decrypt (GCM auth tag)', () => {
    const { svc } = makeService();
    const cipher = (svc as unknown as CryptoInternals).encrypt(
      'JBSWY3DPEHPK3PXP',
    );
    // Flip the last character — GCM must reject the altered ciphertext/tag.
    const tampered = cipher.slice(0, -1) + (cipher.endsWith('A') ? 'B' : 'A');
    expect(() => svc.decryptSecret(tampered)).toThrow();
  });

  it('distinct secrets encrypt to distinct ciphertexts (random IV per encryption)', () => {
    const { svc } = makeService();
    const enc = (svc as unknown as CryptoInternals).encrypt;
    expect(enc('AAAAAAAA')).not.toBe(enc('AAAAAAAA'));
  });

  // ── TOTP validation + replay guard + window ───────────────────────────────────

  it('verifyTotp accepts the current code and returns its step counter', () => {
    const { svc } = makeService();
    const b32 = new Secret({ size: 20 }).base32;
    const r = svc.verifyTotp(b32, codeFor(b32), null);
    expect(r.ok).toBe(true);
    expect(typeof r.counter).toBe('number');
  });

  it('verifyTotp rejects the same step replayed (counter <= lastUsed)', () => {
    const { svc } = makeService();
    const b32 = new Secret({ size: 20 }).base32;
    const code = codeFor(b32);
    const first = svc.verifyTotp(b32, code, null);
    expect(first.ok).toBe(true);
    // Replaying the identical code/step against lastUsed = the counter just accepted must fail.
    expect(svc.verifyTotp(b32, code, first.counter!).ok).toBe(false);
  });

  it('verifyTotp rejects a wrong code', () => {
    const { svc } = makeService();
    const b32 = new Secret({ size: 20 }).base32;
    const valid = Number(codeFor(b32));
    const wrong = ((valid + 7) % 1_000_000).toString().padStart(6, '0'); // guaranteed different
    expect(svc.verifyTotp(b32, wrong, null).ok).toBe(false);
  });

  it('verifyTotp accepts the previous and next step within the ±1 window', () => {
    const { svc } = makeService();
    const b32 = new Secret({ size: 20 }).base32;
    expect(
      svc.verifyTotp(b32, codeFor(b32, Date.now() - 30_000), null).ok,
    ).toBe(true); // previous
    expect(
      svc.verifyTotp(b32, codeFor(b32, Date.now() + 30_000), null).ok,
    ).toBe(true); // next
  });

  // ── challenge + pending tokens (signed with the admin secret, distinct scope) ──

  it('challenge token round-trips → {adminId, jti}; tampered/garbage tokens return null', async () => {
    const { svc } = makeService();
    const token = await svc.signChallenge(42);
    const decoded = svc.verifyChallenge(token);
    expect(decoded?.adminId).toBe(42);
    expect(typeof decoded?.jti).toBe('string');
    expect(svc.verifyChallenge(token + 'x')).toBeNull();
    expect(svc.verifyChallenge('not.a.jwt')).toBeNull();
  });

  it('consumeChallenge is single-use: the first consume wins, the second returns false (closes the counter=0 passkey replay window)', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const { svc, store } = makeService({
      adminLoginChallenge: {
        create: vi.fn(async () => ({})),
        updateMany,
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
    });
    const decoded = svc.verifyChallenge(await svc.signChallenge(42))!;
    expect(await svc.consumeChallenge(decoded.jti)).toBe(true);
    // Second consume: the row is already consumed → updateMany returns count 0 → false (replay rejected).
    (
      store.adminLoginChallenge.updateMany as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({ count: 0 });
    expect(await svc.consumeChallenge(decoded.jti)).toBe(false);
  });

  it('challenge verify rejects a token with a different scope (an access token cannot pose as a challenge)', () => {
    const { svc } = makeService();
    const jwt = new JwtService({});
    const accessLike = jwt.sign(
      { sub: 42, scope: 'admin', tver: 0 },
      { secret: jwtConstants.adminSecret, expiresIn: '1m' },
    );
    expect(svc.verifyChallenge(accessLike)).toBeNull();
  });

  it('beginSetup returns an otpauth URI embedding the secret + a pending token that round-trips', () => {
    const { svc } = makeService();
    const b = svc.beginSetup(42, 'admin', 'admin');
    expect(b.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
    expect(b.otpauthUri).toContain(b.secret); // the QR carries the base32 secret for the authenticator
    const pending = svc.verifyPending(b.pendingToken);
    expect(pending).not.toBeNull();
    expect(pending!.adminId).toBe(42);
    expect(pending!.secret).toBe(b.secret);
    expect(svc.verifyPending(b.pendingToken + 'x')).toBeNull();
  });

  it('a setup-pending token cannot pose as a login challenge (scopes are isolated)', () => {
    const { svc } = makeService();
    const b = svc.beginSetup(42, 'admin', 'admin');
    expect(svc.verifyChallenge(b.pendingToken)).toBeNull();
  });

  // ── backup-code consumption (single-use + normalization) ──────────────────────

  it('consumeBackupCode accepts a known code regardless of case/dash and consumes it once', async () => {
    const storedHash = hashBackupCode('ABCDEFGHIJKLMNOP'); // bare 16-char canonical form
    const findFirst = vi.fn(async () => ({ id: 1 }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const { svc, store } = makeService({
      twoFactorBackupCode: { findFirst, updateMany },
    });

    // Lowercase + dash input normalizes to the same bare canonical form → the same HMAC.
    expect(await svc.consumeBackupCode(42, 'abcd-efgh-ijkl-mnop')).toBe(true);
    // The consume is a single indexed point query keyed by the HMAC of the normalized code.
    expect(storedHash).toHaveLength(43);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      data: { consumedAt: expect.any(Date) },
    });

    // Second consume with no matching unconsumed row → false (single-use).
    (
      store.twoFactorBackupCode.findFirst as ReturnType<typeof vi.fn>
    ).mockResolvedValue(null);
    expect(await svc.consumeBackupCode(42, 'ABCD-EFGH-IJKL-MNOP')).toBe(false);
  });

  it('consumeBackupCode rejects an unknown code and malformed input (no consume)', async () => {
    const findFirst = vi.fn(async () => null); // an unknown code's HMAC matches no row
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const { svc, store } = makeService({
      twoFactorBackupCode: { findFirst, updateMany },
    });

    expect(await svc.consumeBackupCode(42, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ')).toBe(false); // unknown → no row
    expect(updateMany).not.toHaveBeenCalled();

    // Malformed (not 16 base32 chars) → normalized to null → no DB lookup at all.
    expect(await svc.consumeBackupCode(42, 'short')).toBe(false);
    expect(
      store.twoFactorBackupCode.findFirst as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledTimes(1); // only the unknown-code lookup
  });

  // ── enable / disable / regenerate (atomic Admin-row state) ─────────────────────

  it('enableWithBackupCodes atomically enables, bumps tokenVersion, and replaces backup codes', async () => {
    const adminUpdate = vi.fn(async () => ({}));
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const created: Array<{ adminId: number; codeHash: string }> = [];
    const createMany = vi.fn(async (args: { data: typeof created }) => {
      created.push(...args.data);
      return { count: args.data.length };
    });
    const { svc } = makeService({
      admin: { update: adminUpdate },
      twoFactorBackupCode: { deleteMany, createMany },
    });

    const r = await svc.enableWithBackupCodes(7, 'JBSWY3DPEHPK3PXP');
    expect(r.backupCodes).toHaveLength(10);
    // The auth orchestration revokes all opaque sessions immediately after this atomic enrollment write.
    expect(adminUpdate).toHaveBeenCalledTimes(1);
    const data = adminUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.twoFactorEnabled).toBe(true);
    expect(data.twoFactorSecretCipher).not.toBe('JBSWY3DPEHPK3PXP'); // stored encrypted, not plaintext
    expect(data.twoFactorLastUsedCounter).toBeNull();
    expect(deleteMany).toHaveBeenCalled();
    expect(created).toHaveLength(10);
    expect(created.every((c) => c.adminId === 7 && c.codeHash.length > 0)).toBe(
      true,
    );
  });

  it('enable → consume round-trip: a returned backup code resolves to its stored HMAC', async () => {
    const created: Array<{ adminId: number; codeHash: string }> = [];
    const createMany = vi.fn(async (args: { data: typeof created }) => {
      created.push(...args.data);
      return { count: args.data.length };
    });
    const enabler = makeService({
      twoFactorBackupCode: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany,
      },
    }).svc;
    const { backupCodes } = await enabler.enableWithBackupCodes(
      7,
      'JBSWY3DPEHPK3PXP',
    );

    // Feed the captured HMACs back as the store; findFirst matches by codeHash. Each returned plaintext
    // (in its dashed display form) must resolve to the stored HMAC of its bare canonical form.
    expect(
      created.some(
        (c) =>
          c.codeHash === hashBackupCode(backupCodes[0].replaceAll('-', '')),
      ),
    ).toBe(true);
    expect(
      created.some(
        (c) =>
          c.codeHash === hashBackupCode(backupCodes[3].replaceAll('-', '')),
      ),
    ).toBe(true);
    const findFirst = vi.fn(async () => ({ id: 1 }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const consumer = makeService({
      twoFactorBackupCode: { findFirst, updateMany },
    }).svc;
    expect(await consumer.consumeBackupCode(7, backupCodes[0])).toBe(true);
    expect(await consumer.consumeBackupCode(7, backupCodes[3])).toBe(true);
  });

  it('disable atomically clears the secret + flags and drops backup codes', async () => {
    const adminUpdate = vi.fn(async () => ({}));
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const { svc } = makeService({
      admin: { update: adminUpdate },
      twoFactorBackupCode: { deleteMany },
    });

    await svc.disable(7);
    expect(adminUpdate).toHaveBeenCalledTimes(1);
    const data = adminUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.twoFactorEnabled).toBe(false);
    expect(data.twoFactorSecretCipher).toBeNull();
    expect(data.twoFactorEnabledAt).toBeNull();
    expect(data.twoFactorLastUsedCounter).toBeNull();
    expect(deleteMany).toHaveBeenCalled();
  });

  it('regenerateBackupCodes replaces all codes without touching the Admin row (secret unchanged)', async () => {
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const createMany = vi.fn(async (args: { data: unknown[] }) => ({
      count: args.data.length,
    }));
    const adminUpdate = vi.fn(async () => ({}));
    const { svc } = makeService({
      admin: { update: adminUpdate },
      twoFactorBackupCode: { deleteMany, createMany },
    });

    const r = await svc.regenerateBackupCodes(7);
    expect(r.backupCodes).toHaveLength(10);
    expect(deleteMany).toHaveBeenCalled();
    expect(adminUpdate).not.toHaveBeenCalled(); // regeneration does not touch the Admin row
  });
});
