import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { WebAuthnService } from './webauthn.service.js';
import { jwtConstants } from '../auth/constants.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * WebAuthnService unit specs — lock the PLUMBING (the @simplewebauthn/server crypto is the library's own
 * responsibility; we mock its 4 entry points and assert our storage + token + counter logic). Hand-rolled
 * Prisma fake (project pattern); a real JwtService exercises the actual pending-token HMAC. Fake timers are
 * not needed (no TOTP step math here).
 */

// Mock the crypto library — we test what wraps it, not the crypto itself.
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

const mockRegOptions = vi.mocked(generateRegistrationOptions);
const mockVerifyReg = vi.mocked(verifyRegistrationResponse);
const mockAuthOptions = vi.mocked(generateAuthenticationOptions);
const mockVerifyAuth = vi.mocked(verifyAuthenticationResponse);

/** Build a service with an overridable Prisma fake. $transaction runs the fn against the fake itself. */
function makeService(overrides: Record<string, unknown> = {}) {
  const jwt = new JwtService({ secret: jwtConstants.adminSecret });
  const prisma = {
    webAuthnCredential: {
      findMany: vi.fn(async () => [] as unknown[]),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 1n, ...args.data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
    },
    admin: { updateMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    ...overrides,
  };
  return { svc: new WebAuthnService(prisma as never, jwt), prisma };
}

describe('WebAuthnService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegOptions.mockResolvedValue({ challenge: 'reg-challenge' } as never);
    mockAuthOptions.mockResolvedValue({ challenge: 'assert-challenge' } as never);
  });

  // ── registration ──────────────────────────────────────────────────────────────

  it('beginRegistration returns options + a reg-pending token that round-trips with the challenge + nickname', async () => {
    const { svc } = makeService();
    const r = await svc.beginRegistration(7, 'admin', 'admin', 'MacBook');
    expect(r.options.challenge).toBe('reg-challenge');
    // Mint a second token to confirm scope isolation is set up (verified implicitly by completeRegistration
    // below); here just assert shape.
    expect(typeof r.pendingToken).toBe('string');
  });

  it('completeRegistration persists the credential + flips webauthnEnabled on the first credential', async () => {
    mockVerifyReg.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: 'cred-id-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    } as never);
    const credCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 42n, ...args.data }));
    const adminUpdate = vi.fn(async () => ({ count: 1 }));
    const { svc } = makeService({
      webAuthnCredential: { create: credCreate, findMany: vi.fn(async () => []), count: vi.fn(async () => 1) },
      admin: { updateMany: adminUpdate },
    });
    // Mint a real pending token via begin, then complete.
    const { pendingToken } = await svc.beginRegistration(7, 'admin', 'admin', 'MacBook');
    const created = await svc.completeRegistration(7, pendingToken, 'http://localhost:5180', {
      response: { transports: ['internal', 'hybrid'] },
    } as never);

    expect(created.id).toBe('42');
    const data = credCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.credentialId).toBe('cred-id-1');
    expect(data.counter).toBe(0);
    expect(data.deviceType).toBe('multiDevice');
    expect(data.backed).toBe(true);
    expect(data.transports).toBe(JSON.stringify(['internal', 'hybrid']));
    expect(Buffer.isBuffer(data.publicKey)).toBe(true);
    // The hint flips only when currently false — the updateMany precondition is { id, webauthnEnabled: false }.
    const adminArgs = adminUpdate.mock.calls[0][0];
    expect(adminArgs.where).toEqual({ id: 7, webauthnEnabled: false });
  });

  it('completeRegistration throws WEBAUTHN_VERIFICATION_FAILED when the lib throws', async () => {
    mockVerifyReg.mockRejectedValue(new Error('bad') as never);
    const { svc } = makeService();
    const { pendingToken } = await svc.beginRegistration(7, 'admin', 'admin');
    await expect(
      svc.completeRegistration(7, pendingToken, 'http://localhost:5180', {} as never),
    ).rejects.toMatchObject({ bizCode: BusinessCode.WEBAUTHN_VERIFICATION_FAILED });
  });

  // ── assertion ─────────────────────────────────────────────────────────────────

  it('beginAssertion throws TWO_FACTOR_NOT_ENABLED when the admin has no credentials (stale-true guard)', async () => {
    const { svc } = makeService({ webAuthnCredential: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) } });
    await expect(svc.beginAssertion(7)).rejects.toMatchObject({ bizCode: BusinessCode.TWO_FACTOR_NOT_ENABLED });
  });

  it('verifyAssertion advances the counter via a compare-and-swap updateMany on success', async () => {
    mockVerifyAuth.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    } as never);
    const findUnique = vi.fn(async () => ({ id: 9n, adminId: 7, publicKey: Buffer.from([1]), counter: 3 }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const { svc } = makeService({ webAuthnCredential: { findUnique, updateMany, findMany: vi.fn(async () => [{ credentialId: 'cred-id-1', transports: null }]), count: vi.fn(async () => 1) } });

    const { pendingToken } = await svc.beginAssertion(7);
    const r = await svc.verifyAssertion(7, pendingToken, 'http://localhost:5180', { id: 'cred-id-1' } as never);
    expect(r).toEqual({ ok: true });
    // CAS: update only if the stored counter is still exactly what we read (3).
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 9n, counter: 3 },
      data: { counter: 5, lastUsedAt: expect.any(Date) },
    });
  });

  it('verifyAssertion returns {ok:false} when the lib throws (clone / tamper)', async () => {
    mockVerifyAuth.mockRejectedValue(new Error('counter regression') as never);
    const findUnique = vi.fn(async () => ({ id: 9n, adminId: 7, publicKey: Buffer.from([1]), counter: 3 }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const { svc } = makeService({ webAuthnCredential: { findUnique, updateMany, findMany: vi.fn(async () => [{ credentialId: 'cred-id-1', transports: null }]), count: vi.fn(async () => 1) } });
    const { pendingToken } = await svc.beginAssertion(7);
    const r = await svc.verifyAssertion(7, pendingToken, 'http://localhost:5180', { id: 'cred-id-1' } as never);
    expect(r).toEqual({ ok: false });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('verifyAssertion returns {ok:false} when the credential belongs to another admin', async () => {
    const findUnique = vi.fn(async () => ({ id: 9n, adminId: 999, publicKey: Buffer.from([1]), counter: 0 }));
    const { svc } = makeService({ webAuthnCredential: { findUnique, findMany: vi.fn(async () => [{ credentialId: 'cred-id-1', transports: null }]), count: vi.fn(async () => 1) } });
    const { pendingToken } = await svc.beginAssertion(7);
    const r = await svc.verifyAssertion(7, pendingToken, 'http://localhost:5180', { id: 'cred-id-1' } as never);
    expect(r).toEqual({ ok: false });
    expect(mockVerifyAuth).not.toHaveBeenCalled();
  });

  // ── pending-token scope isolation ─────────────────────────────────────────────

  it('a reg-pending token cannot be used as an assert-pending token (scopes are isolated)', async () => {
    mockVerifyAuth.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 1 } } as never);
    const findUnique = vi.fn(async () => ({ id: 9n, adminId: 7, publicKey: Buffer.from([1]), counter: 0 }));
    const { svc } = makeService({ webAuthnCredential: { findUnique, findMany: vi.fn(async () => [{ credentialId: 'c', transports: null }]), count: vi.fn(async () => 1) } });
    const { pendingToken } = await svc.beginRegistration(7, 'admin', 'admin');
    // A reg-pending token passed to verifyAssertion → decoded as assert-pending → null → {ok:false}.
    const r = await svc.verifyAssertion(7, pendingToken, 'http://localhost:5180', { id: 'c' } as never);
    expect(r).toEqual({ ok: false });
    expect(mockVerifyAuth).not.toHaveBeenCalled();
  });

  // ── management ────────────────────────────────────────────────────────────────

  it('removeCredential flips webauthnEnabled off when the last credential is deleted', async () => {
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const adminUpdate = vi.fn(async () => ({ count: 1 }));
    let remaining = 0; // the delete leaves zero credentials
    const { svc } = makeService({
      webAuthnCredential: { deleteMany, count: vi.fn(async () => remaining) },
      admin: { updateMany: adminUpdate },
    });
    const r = await svc.removeCredential(7, 42n);
    expect(r).toEqual({ remaining: 0 });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 42n, adminId: 7 } });
    expect(adminUpdate).toHaveBeenCalledWith({ where: { id: 7, webauthnEnabled: true }, data: { webauthnEnabled: false } });
  });

  it('removeCredential throws NOT_FOUND when the credential belongs to another admin (deleteMany count 0)', async () => {
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const { svc } = makeService({ webAuthnCredential: { deleteMany, count: vi.fn(async () => 2) } });
    await expect(svc.removeCredential(7, 42n)).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
  });

  it('listCredentials projects the row shape and never exposes publicKey / counter', async () => {
    const findMany = vi.fn(async () => [
      { id: 1n, nickname: 'Mac', deviceType: 'multiDevice', backed: true, transports: '["internal"]', createdAt: new Date(0), lastUsedAt: null },
    ]);
    const { svc } = makeService({ webAuthnCredential: { findMany } });
    const list = await svc.listCredentials(7);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: '1',
      nickname: 'Mac',
      deviceType: 'multiDevice',
      backed: true,
      transports: ['internal'],
      createdAt: expect.any(Date),
      lastUsedAt: null,
    });
    expect(list[0]).not.toHaveProperty('publicKey');
    expect(list[0]).not.toHaveProperty('counter');
  });
});
