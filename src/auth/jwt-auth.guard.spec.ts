import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import type { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../common/public.decorator.js';
import type { BearerAuthService } from './bearer-auth.service.js';

/**
 * JwtAuthGuard is the global APP_GUARD. It short-circuits to `true` on any route/controller carrying
 * @Public(); otherwise it extracts the Bearer token and delegates to BearerAuthService.resolve, which
 * accepts an access JWT OR a session token. Covered here: the @Public bypass (method + class level),
 * the resolve→req.user happy path, and the 401 when resolve yields null. Pure-vitest, no Nest DI —
 * Reflector + BearerAuthService mocked inline.
 */
describe('JwtAuthGuard (global @Public opt-out + Bearer resolve)', () => {
  const reflector = { getAllAndOverride: vi.fn() };
  const bearerAuth = { resolve: vi.fn() };
  const guard = new JwtAuthGuard(
    reflector as unknown as Reflector,
    bearerAuth as unknown as BearerAuthService,
  );

  const handler = function handler() {};
  class SomeController {}

  function makeCtx(authorization?: string): ExecutionContext {
    const req: {
      headers: Record<string, string>;
      ip?: string;
      user?: { userId: number; sessionId: number | null };
    } = {
      headers: authorization ? { authorization } : {},
      ip: '127.0.0.1',
    };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handler,
      getClass: () => SomeController,
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector.getAllAndOverride.mockReset();
    bearerAuth.resolve.mockReset();
  });

  it('short-circuits to true on a @Public route without invoking BearerAuthService', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    await expect(guard.canActivate(makeCtx('Bearer xyz'))).resolves.toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC, [
      handler,
      SomeController,
    ]);
    expect(bearerAuth.resolve).not.toHaveBeenCalled();
  });

  it('reads class-level @Public via the [handler, class] scan', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    await expect(guard.canActivate(makeCtx())).resolves.toBe(true);
  });

  it('admits a request whose credential resolves to a principal and sets req.user (with sessionId)', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    bearerAuth.resolve.mockResolvedValue({ userId: 42, sessionId: 101 });
    const ctx = makeCtx('Bearer some-token');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(bearerAuth.resolve).toHaveBeenCalledWith('some-token', { ip: '127.0.0.1' });
    expect(
      (ctx.switchToHttp().getRequest() as {
        user: { userId: number; sessionId: number | null };
      }).user,
    ).toEqual({ userId: 42, sessionId: 101 });
  });

  it('rejects (401) when the credential does not resolve', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    bearerAuth.resolve.mockResolvedValue(null);
    await expect(guard.canActivate(makeCtx('Bearer bad'))).rejects.toBeDefined();
  });

  it('rejects (401) when no Bearer header is present on a protected route', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    bearerAuth.resolve.mockResolvedValue(null); // resolve(undefined) → null
    await expect(guard.canActivate(makeCtx())).rejects.toBeDefined();
    expect(bearerAuth.resolve).toHaveBeenCalledWith(undefined, { ip: '127.0.0.1' });
  });
});
