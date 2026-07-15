import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BearerAuthService } from './bearer-auth.service.js';
import type { AccessTokenValidator, AccessPayload } from './access-token.validator.js';
import type { SessionTokenService } from './session-token.service.js';

/**
 * BearerAuthService.resolve is the single auth source shared by the global guard and the media
 * preHandler. Covered: null/empty short-circuit; access-JWT happy path (no session lookup); fall-through
 * to the session token when the credential is not a JWT; and the null result when neither validates.
 */
describe('BearerAuthService', () => {
  const access = {
    verifyToken: vi.fn(),
    validatePayload: vi.fn(),
  };
  const sessions = { validate: vi.fn() };
  const svc = new BearerAuthService(
    access as unknown as AccessTokenValidator,
    sessions as unknown as SessionTokenService,
  );

  beforeEach(() => {
    access.verifyToken.mockReset();
    access.validatePayload.mockReset();
    sessions.validate.mockReset();
  });

  it('returns null for a null/undefined credential without any lookup', async () => {
    await expect(svc.resolve(null)).resolves.toBe(null);
    await expect(svc.resolve(undefined)).resolves.toBe(null);
    expect(access.verifyToken).not.toHaveBeenCalled();
  });

  it('admits a valid access JWT and skips the session lookup (sessionId null — no session row)', async () => {
    const payload: AccessPayload = { sub: 42, jti: 'j', tver: 1 };
    access.verifyToken.mockReturnValue(payload);
    access.validatePayload.mockResolvedValue({ userId: 42 });
    await expect(svc.resolve('eyJ.header.sig')).resolves.toEqual({ userId: 42, sessionId: null });
    expect(sessions.validate).not.toHaveBeenCalled();
  });

  it('falls through to the session token when the credential is not a JWT', async () => {
    access.verifyToken.mockReturnValue(null); // not a JWT → null
    sessions.validate.mockResolvedValue({ userId: 42, sessionId: 101 });
    await expect(svc.resolve('a'.repeat(64))).resolves.toEqual({ userId: 42, sessionId: 101 });
    expect(sessions.validate).toHaveBeenCalledWith('a'.repeat(64), { ip: undefined });
  });

  it('returns null when neither the JWT nor the session token validates', async () => {
    access.verifyToken.mockReturnValue(null);
    sessions.validate.mockResolvedValue(null);
    await expect(svc.resolve('garbage')).resolves.toBe(null);
  });

  it('returns null for a JWT whose payload fails revocation checks (validatePayload → null)', async () => {
    access.verifyToken.mockReturnValue({ sub: 42, jti: 'j', tver: 0 });
    access.validatePayload.mockResolvedValue(null);
    await expect(svc.resolve('eyJ.header.sig')).resolves.toBe(null);
    expect(sessions.validate).not.toHaveBeenCalled();
  });
});
