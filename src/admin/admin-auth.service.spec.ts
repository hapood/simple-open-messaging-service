import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { Secret, TOTP } from 'otpauth';
import { AdminAuthService } from './admin-auth.service.js';
import { TwoFactorService, hashBackupCode } from './two-factor.service.js';
import { WebAuthnService } from './webauthn.service.js';
import { BruteForceService } from '../auth/brute-force.service.js';
import { PasswordHasher } from '../auth/password-hasher.service.js';
import { jwtConstants } from '../auth/constants.js';
import { BusinessCode } from '../common/business-code.js';
import {
  admin as adminTable,
  adminLoginChallenge,
  adminSession,
  twoFactorBackupCode,
} from '../database/schema.js';

/**
 * AdminAuthService orchestration specs — lock the login two-step contract and the brute-force escalation,
 * using a REAL TwoFactorService (real AES-GCM + TOTP + JWT) and a REAL BruteForceService (in-memory) over a
 * hand-rolled Drizzle fake. This exercises the actual crypto + ban math end-to-end (no Nest DI container),
 * matching the project's spec style.
 */

const FIXED_NOW = new Date(2026, 5, 17, 12, 0, 0, 0).getTime();
const PASSWORD = 'correct-pw-123';

/** A valid 6-digit TOTP for a base32 secret at the (faked) current time. */
function codeFor(b32: string): string {
  return new TOTP({
    issuer: 'SOMS Admin',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(b32),
  }).generate();
}

type Overrides = {
  twoFactorEnabled?: boolean;
  webauthnEnabled?: boolean;
  webauthnVerifyOk?: boolean; // the WebAuthnService.verifyAssertion stub result (default true)
  adminEnabled?: boolean;
  adminPresent?: boolean;
  backupCode?: string | null; // a BARE 16-char backup code to seed into the store (null = no store)
};

/** Build an AdminAuthService wired to real TwoFactor + real BruteForce + a database fake. */
async function setup(o: Overrides = {}) {
  const jwt = new JwtService({ secret: jwtConstants.adminSecret });
  const passwordHasher = new PasswordHasher();
  const twoFactor = new TwoFactorService({} as never, jwt);
  const bruteForce = new BruteForceService();

  const secret = new Secret({ size: 20 }).base32;
  // Encrypt via the real service's private helper (pure — depends only on the module-level key).
  const cipher = (
    twoFactor as unknown as { encrypt: (s: string) => string }
  ).encrypt(secret);

  const admin = {
    id: 7,
    userId: 42,
    role: 'SUPER_ADMIN',
    enabled: o.adminEnabled ?? true,
    twoFactorEnabled: o.twoFactorEnabled ?? false,
    webauthnEnabled: o.webauthnEnabled ?? false,
    twoFactorSecretCipher: o.twoFactorEnabled ? cipher : null,
    twoFactorEnabledAt: null,
    twoFactorLastUsedCounter: null,
    user: { account: 'admin', name: 'admin' },
  };
  const user = {
    id: 42,
    account: 'admin',
    isDeleted: false,
    isGroup: false,
    hashPwd: await passwordHasher.hash(PASSWORD),
  };

  // o.backupCode is a BARE 16-char canonical code; store its HMAC (exactly what consume looks up).
  const backupRows = o.backupCode
    ? [{ id: 1, codeHash: hashBackupCode(o.backupCode) }]
    : [];

  const store = {
    user: { findUnique: vi.fn(async () => user) },
    admin: {
      findUnique: vi.fn(async () => (o.adminPresent === false ? null : admin)),
      update: vi.fn(async () => ({})),
    },
    adminSession: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        ...args.data,
        id: 1,
      })),
      updateMany: vi.fn(async () => ({ count: 0 })), // revokeSessionsByAdmin routes here
    },
    twoFactorBackupCode: {
      // consume is now an indexed findFirst by codeHash; return the seeded row iff the HMAC matches.
      findFirst: vi.fn(async ({ where }: { where: { codeHash?: string } }) =>
        backupRows.some((r) => r.codeHash === where.codeHash)
          ? { id: 1 }
          : null,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    // AdminLoginChallenge: signChallenge creates a row (single-use jti); consumeChallenge flips it.
    // Default updateMany returns count 1 (first consume wins) — individual tests override to test replay.
    adminLoginChallenge: {
      create: vi.fn(
        async (args: { data: { jti: string; adminId: number } }) => ({
          ...args.data,
        }),
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };

  const db = {
    query: {
      user: { findFirst: store.user.findUnique },
      admin: { findFirst: store.admin.findUnique },
      twoFactorBackupCode: {
        findFirst: vi.fn(async () =>
          backupRows.length > 0 ? { id: 1 } : null,
        ),
      },
    },
    insert: vi.fn((table: unknown) => ({
      values: async (data: Record<string, unknown>) => {
        if (table === adminSession) return store.adminSession.create({ data });
        if (table === adminLoginChallenge)
          return store.adminLoginChallenge.create({ data: data as never });
      },
    })),
    update: vi.fn((table: unknown) => {
      let operation: Promise<unknown> = Promise.resolve(undefined);
      const query = {
        set: (data: Record<string, unknown>) => {
          operation =
            table === adminTable
              ? store.admin.update({ data })
              : table === adminLoginChallenge
                ? store.adminLoginChallenge.updateMany()
                : table === twoFactorBackupCode
                  ? store.twoFactorBackupCode.updateMany()
                  : store.adminSession.updateMany();
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
    }),
    delete: vi.fn(() => ({ where: () => Promise.resolve(undefined) })),
  };
  const database = { db };

  // Re-bind TwoFactor to the fake database so backup-code consume uses the seeded store.
  const twoFactorBound = new TwoFactorService(database as never, jwt);
  // WebAuthnService is stubbed at the orchestration level: the admin-auth specs test ban/issuance
  // branching, not the assertion crypto (that is covered in webauthn.service.spec.ts).
  const webAuthn = {
    beginAssertion: vi.fn(async () => ({
      options: { challenge: 'c' },
      pendingToken: 'pt',
    })),
    verifyAssertion: vi.fn(async () => ({ ok: o.webauthnVerifyOk ?? true })),
    completeRegistration: vi.fn(async () => ({
      id: 'cred-1',
      nickname: 'phone',
      deviceType: 'platform',
      backed: true,
    })),
    removeCredential: vi.fn(async () => ({ remaining: 0 })),
  } as unknown as WebAuthnService;
  const svc = new AdminAuthService(
    database as never,
    jwt,
    bruteForce,
    twoFactorBound,
    passwordHasher,
    webAuthn,
  );

  return {
    svc,
    store,
    twoFactor: twoFactorBound,
    bruteForce,
    secret,
    challengeToken: async () => {
      const r = await svc.login('admin', PASSWORD);
      if (!('twoFactorRequired' in r))
        throw new Error('expected a 2FA challenge');
      return r.challengeToken;
    },
  };
}

/** Assert a promise rejects with a BusinessException carrying the given code. */
async function expectBiz(p: Promise<unknown>, code: number): Promise<void> {
  await expect(p).rejects.toMatchObject({ bizCode: code });
}

describe('AdminAuthService two-factor orchestration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── login branching ───────────────────────────────────────────────────────────

  it('issues an opaque session on correct password when 2FA is NOT enabled', async () => {
    const { svc } = await setup({ twoFactorEnabled: false });
    const r = await svc.login('admin', PASSWORD);
    expect('twoFactorRequired' in r).toBe(false);
    // Narrow the union so sessionToken is reachable (expect().toBe() does not narrow).
    if ('twoFactorRequired' in r)
      throw new Error('expected a session, not a 2FA challenge');
    expect(typeof r.sessionToken).toBe('string');
    expect(r.sessionToken.length).toBeGreaterThan(32);
  });

  it('returns a 2FA challenge (no tokens) on correct password when 2FA IS enabled', async () => {
    const { svc, twoFactor } = await setup({ twoFactorEnabled: true });
    const r = await svc.login('admin', PASSWORD);
    expect('twoFactorRequired' in r).toBe(true);
    if ('twoFactorRequired' in r) {
      expect(r.twoFactorRequired).toBe(true);
      expect(twoFactor.verifyChallenge(r.challengeToken)?.adminId).toBe(7); // decodes to the admin id
    }
  });

  it('rejects a wrong password with INVALID_CREDENTIALS (non-revealing)', async () => {
    const { svc } = await setup({ twoFactorEnabled: false });
    await expectBiz(
      svc.login('admin', 'wrong-password'),
      BusinessCode.INVALID_CREDENTIALS,
    );
  });

  it('escalates to RATE_LIMITED after the password brute-force threshold (progressive ban)', async () => {
    const { svc } = await setup({ twoFactorEnabled: false });
    for (let i = 0; i < 5; i++) {
      await expectBiz(
        svc.login('admin', 'wrong'),
        BusinessCode.INVALID_CREDENTIALS,
      );
    }
    // 6th failure crosses the count:5 tier → RATE_LIMITED + bannedUntil.
    await expectBiz(svc.login('admin', 'wrong'), BusinessCode.RATE_LIMITED);
  });

  it('collapses a disabled / missing admin to INVALID_CREDENTIALS (no enumeration)', async () => {
    const disabled = await setup({
      twoFactorEnabled: false,
      adminEnabled: false,
    });
    await expectBiz(
      disabled.svc.login('admin', PASSWORD),
      BusinessCode.INVALID_CREDENTIALS,
    );

    const missing = await setup({
      twoFactorEnabled: false,
      adminPresent: false,
    });
    await expectBiz(
      missing.svc.login('admin', PASSWORD),
      BusinessCode.INVALID_CREDENTIALS,
    );
  });

  // ── verifyLogin (the second step) ─────────────────────────────────────────────

  it('completes login on a valid TOTP and advances the replay counter', async () => {
    const { svc, store, secret, challengeToken } = await setup({
      twoFactorEnabled: true,
    });
    const token = await challengeToken();
    const r = await svc.verifyLogin(token, codeFor(secret), undefined);
    expect(typeof r.sessionToken).toBe('string');
    // The accepted step counter was written back as the replay guard.
    const update = store.admin.update.mock.calls[0][0].data;
    expect(update.twoFactorLastUsedCounter).toBe(
      Math.floor(FIXED_NOW / 30_000),
    );
  });

  it('rejects a wrong TOTP with TWO_FACTOR_INVALID', async () => {
    const { svc, challengeToken } = await setup({ twoFactorEnabled: true });
    const token = await challengeToken();
    await expectBiz(
      svc.verifyLogin(token, '000000', undefined),
      BusinessCode.TWO_FACTOR_INVALID,
    );
  });

  it('escalates to RATE_LIMITED after the 2FA brute-force threshold', async () => {
    const { svc, challengeToken } = await setup({ twoFactorEnabled: true });
    const token = await challengeToken();
    for (let i = 0; i < 5; i++) {
      await expectBiz(
        svc.verifyLogin(token, '000000', undefined),
        BusinessCode.TWO_FACTOR_INVALID,
      );
    }
    await expectBiz(
      svc.verifyLogin(token, '000000', undefined),
      BusinessCode.RATE_LIMITED,
    );
  });

  it('completes login on a valid backup code (single-use consumed)', async () => {
    const { svc, challengeToken } = await setup({
      twoFactorEnabled: true,
      backupCode: 'ABCDEFGHIJKLMNOP', // bare 16-char canonical
    });
    const token = await challengeToken();
    const r = await svc.verifyLogin(token, undefined, 'abcd-efgh-ijkl-mnop'); // lowercase + dash → same bare
    expect(typeof r.sessionToken).toBe('string');
  });

  it('rejects an invalid/expired challenge token with TWO_FACTOR_CHALLENGE_EXPIRED', async () => {
    const { svc } = await setup({ twoFactorEnabled: true });
    await expectBiz(
      svc.verifyLogin('garbage.token', codeFor('JBSWY3DPEHPK3PXP'), undefined),
      BusinessCode.TWO_FACTOR_CHALLENGE_EXPIRED,
    );
  });

  it('rejects verify when 2FA was disabled mid-challenge (TWO_FACTOR_NOT_ENABLED)', async () => {
    // Mint a validly-signed challenge against an enabled admin, then verify it against a service whose
    // admin row has since had 2FA disabled — the gate must fire before any code check.
    const enabled = await setup({ twoFactorEnabled: true });
    const token = await enabled.challengeToken();
    const disabled = await setup({ twoFactorEnabled: false });
    await expectBiz(
      disabled.svc.verifyLogin(token, '123456', undefined),
      BusinessCode.TWO_FACTOR_NOT_ENABLED,
    );
  });

  // ── WebAuthn login branching + assertion ─────────────────────────────────────

  it('login advertises factors {totp:false, webauthn:true} for a passkey-only admin', async () => {
    const { svc } = await setup({ webauthnEnabled: true });
    const r = await svc.login('admin', PASSWORD);
    expect('twoFactorRequired' in r).toBe(true);
    if ('twoFactorRequired' in r)
      expect(r.factors).toEqual({ totp: false, webauthn: true });
  });

  it('login advertises both factors when TOTP and a passkey are enrolled', async () => {
    const { svc } = await setup({
      twoFactorEnabled: true,
      webauthnEnabled: true,
    });
    const r = await svc.login('admin', PASSWORD);
    if ('twoFactorRequired' in r)
      expect(r.factors).toEqual({ totp: true, webauthn: true });
  });

  it('login issues an opaque session directly when no second factor is enrolled', async () => {
    const { svc } = await setup({}); // both flags default false
    const r = await svc.login('admin', PASSWORD);
    expect('twoFactorRequired' in r).toBe(false);
  });

  it('verifyWebAuthnLogin completes the session on a valid assertion', async () => {
    const { svc, challengeToken } = await setup({ webauthnEnabled: true });
    const challenge = await challengeToken();
    const r = await svc.verifyWebAuthnLogin(
      challenge,
      'pending-token',
      {} as never,
      'http://localhost:5180',
    );
    expect(typeof r.sessionToken).toBe('string');
  });

  it('verifyWebAuthnLogin rejects a failed assertion with TWO_FACTOR_INVALID, then RATE_LIMITED at the threshold', async () => {
    const { svc, challengeToken } = await setup({
      webauthnEnabled: true,
      webauthnVerifyOk: false,
    });
    const challenge = await challengeToken();
    for (let i = 0; i < 5; i++) {
      await expectBiz(
        svc.verifyWebAuthnLogin(
          challenge,
          'pending-token',
          {} as never,
          'http://localhost:5180',
        ),
        BusinessCode.TWO_FACTOR_INVALID,
      );
    }
    // 6th failed assertion crosses the count:5 tier → RATE_LIMITED.
    await expectBiz(
      svc.verifyWebAuthnLogin(
        challenge,
        'pending-token',
        {} as never,
        'http://localhost:5180',
      ),
      BusinessCode.RATE_LIMITED,
    );
  });

  // ── passkey lifecycle: additive factor, sessions stay valid ───────────────────

  it('passkey enroll/remove does NOT revoke existing sessions (additive factor)', async () => {
    const { svc, store } = await setup({ webauthnEnabled: true });
    // revokeSessionsByAdmin routes through adminSession.updateMany — pin that neither enroll nor remove
    // touches it (a passkey is an additive optional factor; enroll already required password re-auth).
    await svc.completeWebAuthnRegistration(7, 'pending-token', {} as never);
    await svc.removeWebAuthnCredential(7, 1);
    expect(store.adminSession.updateMany).not.toHaveBeenCalled();
  });
});
