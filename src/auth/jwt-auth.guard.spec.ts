import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import type { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../common/public.decorator.js';

/**
 * JwtAuthGuard is registered globally (APP_GUARD in AuthModule) and short-circuits to `true` on any
 * route/controller carrying @Public(), else delegates to passport's 'jwt' strategy (super.canActivate).
 *
 * Covered: the @Public bypass (method-level and class-level — getAllAndOverride scans [handler, class])
 * consults the right metadata key and returns a synchronous `true` WITHOUT touching the JWT path; a
 * non-@Public route falls through to super. Pure-vitest, no Nest DI — Reflector mocked inline. The real
 * 401-on-missing-token behavior of the passport path is exercised end-to-end by test/auth.e2e-spec.ts.
 */
describe('JwtAuthGuard (global @Public opt-out)', () => {
  const reflector = {
    getAllAndOverride: vi.fn(),
  };
  const guard = new JwtAuthGuard(reflector as unknown as Reflector);

  // Stable identities so the getAllAndOverride call args can be asserted by reference.
  const handler = function handler() {};
  class SomeController {}

  /** A bare ExecutionContext — no Authorization header, so the passport path (if reached) finds no token. */
  function makeCtx(): ExecutionContext {
    const req = {};
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handler,
      getClass: () => SomeController,
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector.getAllAndOverride.mockReset();
  });

  it('short-circuits to true on a @Public route without invoking the JWT strategy', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    expect(guard.canActivate(makeCtx())).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC, [handler, SomeController]);
  });

  it('reads class-level @Public via the [handler, class] scan (handler carries no metadata)', () => {
    // getAllAndOverride returns the class's true even when the handler itself is bare — that is exactly
    // how a controller-level @Public() covers every method on it.
    reflector.getAllAndOverride.mockReturnValue(true);
    expect(guard.canActivate(makeCtx())).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC, [handler, SomeController]);
  });

  it('falls through to super.canActivate (passport) when the route is not @Public', async () => {
    // No @Public metadata → getAllAndOverride returns undefined → the guard must NOT short-circuit; it
    // delegates to super.canActivate. There is no 'jwt' strategy wired in this unit test (no JwtStrategy
    // constructed), so super rejects — which proves the bypass was skipped. The real 401 is covered by
    // test/auth.e2e-spec.ts.
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(makeCtx())).rejects.toBeDefined();
  });
});
