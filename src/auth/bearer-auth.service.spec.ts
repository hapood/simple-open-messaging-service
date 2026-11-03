import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BearerAuthService } from './bearer-auth.service.js';
import { BAN_DIM_IP, BruteForceService } from './brute-force.service.js';
import { IP_AUTH_FAILURE_STEPS } from './ip-auth-policy.js';
import { LocalStrategy } from './local.strategy.js';
import type { AuthService } from './auth.service.js';
import type { FastifyRequest } from 'fastify';
import type { SessionTokenService } from './session-token.service.js';

/**
 * BearerAuthService.resolve is the single auth source shared by the global guard and the media
 * preHandler — it resolves the long-lived session token (no access JWT anymore). Covered: null/empty
 * short-circuit; a valid session token → {userId, sessionId}; an invalid token → null; the ip opt
 * threads through (the sliding activity write).
 */
describe('BearerAuthService', () => {
  const sessions = { validate: vi.fn() };
  let bruteForce: BruteForceService;
  let svc: BearerAuthService;

  beforeEach(() => {
    sessions.validate.mockReset();
    bruteForce = new BruteForceService();
    svc = new BearerAuthService(
      sessions as unknown as SessionTokenService,
      bruteForce,
    );
  });

  it('returns null for a null/undefined credential without any lookup', async () => {
    await expect(svc.resolve(null)).resolves.toBe(null);
    await expect(svc.resolve(undefined)).resolves.toBe(null);
    expect(sessions.validate).not.toHaveBeenCalled();
  });

  it('resolves a valid session token to { userId, sessionId, mustChangePassword }', async () => {
    sessions.validate.mockResolvedValue({
      userId: 42,
      sessionId: 101,
      mustChangePassword: false,
    });
    await expect(svc.resolve('a'.repeat(64))).resolves.toEqual({
      userId: 42,
      sessionId: 101,
      mustChangePassword: false,
    });
    expect(sessions.validate).toHaveBeenCalledWith('a'.repeat(64), {
      ip: undefined,
    });
  });

  it('threads the request ip into the session validation', async () => {
    sessions.validate.mockResolvedValue({
      userId: 42,
      sessionId: 101,
      mustChangePassword: false,
    });
    await svc.resolve('a'.repeat(64), { ip: '1.2.3.4' });
    expect(sessions.validate).toHaveBeenCalledWith('a'.repeat(64), {
      ip: '1.2.3.4',
    });
  });

  it('returns null for an invalid / unknown token', async () => {
    sessions.validate.mockResolvedValue(null);
    await expect(svc.resolve('b'.repeat(64))).resolves.toBe(null);
  });

  it('rejects malformed tokens before storage and bans on the eleventh failure', async () => {
    for (let i = 0; i < 10; i++) {
      await expect(
        svc.resolve('garbage', { ip: '192.0.2.1' }),
      ).resolves.toBeNull();
    }
    await expect(
      svc.resolve('garbage', { ip: '192.0.2.1' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(sessions.validate).not.toHaveBeenCalled();
    await expect(
      svc.resolve('a'.repeat(64), { ip: '::ffff:192.0.2.1' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(sessions.validate).not.toHaveBeenCalled();
  });

  it('shares failures and bans with password login in both directions', async () => {
    const auth = { validateUser: vi.fn().mockResolvedValue(undefined) };
    const strategy = new LocalStrategy(
      auth as unknown as AuthService,
      bruteForce,
    );
    const req = { ip: '192.0.2.2' } as FastifyRequest;
    for (let i = 0; i < 10; i++)
      await strategy.validate(req, `user${i}`, 'bad');
    await expect(svc.resolve('bad', { ip: req.ip })).rejects.toMatchObject({
      status: 429,
    });
    expect(await strategy.validate(req, 'another', 'bad')).toMatchObject({
      status: 1,
      bannedUntil: expect.any(Number),
    });
    expect(auth.validateUser).toHaveBeenCalledTimes(10);
    bruteForce.unban({ ip: req.ip });
    await expect(svc.resolve('bad', { ip: req.ip })).resolves.toBeNull();
  });

  it('does not count missing credentials or storage failures, or clear failures on success', async () => {
    const failure = vi.spyOn(bruteForce, 'registerFailure');
    await svc.resolve('', { ip: '192.0.2.3' });
    sessions.validate.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      svc.resolve('a'.repeat(64), { ip: '192.0.2.3' }),
    ).rejects.toThrow('database unavailable');
    expect(failure).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++)
      bruteForce.registerFailure(
        BAN_DIM_IP,
        '192.0.2.3',
        IP_AUTH_FAILURE_STEPS,
      );
    sessions.validate.mockResolvedValue({ userId: 1, sessionId: 2 });
    await svc.resolve('a'.repeat(64), { ip: '192.0.2.3' });
    await expect(svc.resolve('bad', { ip: '192.0.2.3' })).rejects.toMatchObject(
      { status: 429 },
    );
  });
});
