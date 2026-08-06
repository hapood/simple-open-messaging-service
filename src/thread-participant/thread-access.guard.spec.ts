import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ThreadAccessGuard } from './thread-access.guard.js';
import type { ThreadParticipantService } from './thread-participant.service.js';
import type { Reflector } from '@nestjs/core';
import { BusinessCode } from '../common/business-code.js';
import { RESOURCE_ID_KEY } from '../common/resource-id.decorator.js';

/**
 * ThreadAccessGuard is the single membership gate for every message route (send / query / mark-read).
 * Covered: active member → attaches req.threadAccess; non-member → THREAD_NOT_FOUND (non-leaking); a
 * non-number threadId (raw body, pre-ValidationPipe) → VALIDATION_FAILED; route missing @ResourceId →
 * INTERNAL (a wiring bug, not a client error). Pure-vitest, no Nest DI — collaborators
 * (ThreadParticipantService, Reflector) mocked inline.
 */
describe('ThreadAccessGuard', () => {
  const participantService = {
    findActiveParticipantWithThread: vi.fn(),
  };
  // The guard reads the body field the route declared via @ResourceId<Dto>('threadId'). The mock
  // returns that field by default; the "missing @ResourceId" test overrides it to undefined.
  const reflector = {
    get: vi.fn().mockReturnValue('threadId'),
  };
  const guard = new ThreadAccessGuard(
    participantService as unknown as ThreadParticipantService,
    reflector as unknown as Reflector,
  );

  // Call history on the shared mocks persists across tests; reset so per-test assertions see only the
  // current test's calls.
  beforeEach(() => {
    participantService.findActiveParticipantWithThread.mockReset();
    reflector.get.mockReset();
    reflector.get.mockReturnValue('threadId');
  });

  /** Build a fake ExecutionContext around a request with the given (optional) userId + body. */
  function makeCtx(
    userId: number | undefined,
    body: unknown,
  ): ExecutionContext {
    const req = {
      user: userId === undefined ? undefined : { userId },
      body,
    };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getType: () => 'http',
    } as unknown as ExecutionContext;
  }

  it('attaches req.threadAccess and allows an ACTIVE member', async () => {
    const participant = {
      id: 9,
      userId: 7,
      threadId: 12,
      leftAt: null,
      thread: { type: 'P2P' },
    };
    participantService.findActiveParticipantWithThread.mockResolvedValueOnce(
      participant,
    );
    const ctx = makeCtx(7, { threadId: 12 });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(reflector.get).toHaveBeenCalledWith(
      RESOURCE_ID_KEY,
      expect.anything(),
    );
    expect(
      participantService.findActiveParticipantWithThread,
    ).toHaveBeenCalledWith(7, 12);
    expect(
      (ctx.switchToHttp().getRequest() as { threadAccess: unknown })
        .threadAccess,
    ).toEqual({
      threadId: 12,
      threadType: 'P2P',
      participant,
      friendshipActive: true,
      membershipActive: true,
      groupDissolved: false,
    });
  });

  it('allows retained P2P history after unfriend but marks it read-only', async () => {
    const participant = {
      id: 9,
      userId: 7,
      threadId: 12,
      leftAt: new Date(),
      thread: { type: 'P2P' },
    };
    participantService.findActiveParticipantWithThread.mockResolvedValueOnce(
      participant,
    );
    const ctx = makeCtx(7, { threadId: 12 });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(
      (
        ctx.switchToHttp().getRequest() as {
          threadAccess: { friendshipActive: boolean };
        }
      ).threadAccess.friendshipActive,
    ).toBe(false);
  });

  it('throws THREAD_NOT_FOUND (non-leaking) when the caller is not an active member', async () => {
    participantService.findActiveParticipantWithThread.mockResolvedValueOnce(
      null,
    );
    const ctx = makeCtx(7, { threadId: 12 });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      bizCode: BusinessCode.THREAD_NOT_FOUND,
    });
  });

  it('throws VALIDATION_FAILED when threadId is a non-number (raw body, pre-ValidationPipe)', async () => {
    // Guards run before ValidationPipe coerces, so a client-sent string reaches the guard verbatim —
    // it must be rejected here or it surfaces as an opaque database 500.
    const ctx = makeCtx(7, { threadId: '12' });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
    });
    expect(
      participantService.findActiveParticipantWithThread,
    ).not.toHaveBeenCalled();
  });

  it('throws INTERNAL when the route is missing @ResourceId (wiring bug, not a client error)', async () => {
    reflector.get.mockReturnValue(undefined);
    const ctx = makeCtx(7, { threadId: 12 });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      bizCode: BusinessCode.INTERNAL,
    });
    expect(
      participantService.findActiveParticipantWithThread,
    ).not.toHaveBeenCalled();
  });
});
