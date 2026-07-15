import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BearerAuthService } from './bearer-auth.service.js';
import type { SessionTokenService } from './session-token.service.js';

/**
 * BearerAuthService.resolve is the single auth source shared by the global guard and the media
 * preHandler — it resolves the long-lived session token (no access JWT anymore). Covered: null/empty
 * short-circuit; a valid session token → {userId, sessionId}; an invalid token → null; the ip opt
 * threads through (the sliding activity write).
 */
describe('BearerAuthService', () => {
  const sessions = { validate: vi.fn() };
  const svc = new BearerAuthService(sessions as unknown as SessionTokenService);

  beforeEach(() => sessions.validate.mockReset());

  it('returns null for a null/undefined credential without any lookup', async () => {
    await expect(svc.resolve(null)).resolves.toBe(null);
    await expect(svc.resolve(undefined)).resolves.toBe(null);
    expect(sessions.validate).not.toHaveBeenCalled();
  });

  it('resolves a valid session token to { userId, sessionId }', async () => {
    sessions.validate.mockResolvedValue({ userId: 42, sessionId: 101 });
    await expect(svc.resolve('a'.repeat(64))).resolves.toEqual({ userId: 42, sessionId: 101 });
    expect(sessions.validate).toHaveBeenCalledWith('a'.repeat(64), { ip: undefined });
  });

  it('threads the request ip into the session validation', async () => {
    sessions.validate.mockResolvedValue({ userId: 42, sessionId: 101 });
    await svc.resolve('tok', { ip: '1.2.3.4' });
    expect(sessions.validate).toHaveBeenCalledWith('tok', { ip: '1.2.3.4' });
  });

  it('returns null for an invalid / unknown token', async () => {
    sessions.validate.mockResolvedValue(null);
    await expect(svc.resolve('garbage')).resolves.toBe(null);
  });
});
