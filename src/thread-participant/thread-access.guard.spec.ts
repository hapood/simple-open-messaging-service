import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ThreadAccessGuard } from './thread-access.guard.js';
import type { ThreadParticipantService } from './thread-participant.service.js';
import { BusinessCode } from '../common/business-code.js';

/**
 * ThreadAccessGuard is the single membership gate for every message route (send / query / mark-read),
 * so its three outcomes are covered here: active member → attaches req.threadAccess; non-member →
 * THREAD_NOT_FOUND (deliberately non-leaking); missing threadId → VALIDATION_FAILED (defensive).
 * Pure-vitest, no Nest DI — the guard's only collaborator is ThreadParticipantService, mocked inline.
 */
describe('ThreadAccessGuard', () => {
  const participantService = {
    findActiveParticipant: vi.fn(),
  };
  const guard = new ThreadAccessGuard(
    participantService as unknown as ThreadParticipantService,
  );

  // Call history on the shared mock persists across tests; reset so per-test "called / not called"
  // assertions see only the current test's calls.
  beforeEach(() => {
    participantService.findActiveParticipant.mockReset();
  });

  /** Build a fake ExecutionContext around a request with the given (optional) userId + body. */
  function makeCtx(userId: number | undefined, body: unknown): ExecutionContext {
    const req = {
      user: userId === undefined ? undefined : { userId },
      body,
    };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getType: () => 'http',
    } as unknown as ExecutionContext;
  }

  it('attaches req.threadAccess and allows an ACTIVE member', async () => {
    const participant = { id: 9, userId: 7, threadId: 12, leftAt: null };
    participantService.findActiveParticipant.mockResolvedValueOnce(participant);
    const ctx = makeCtx(7, { threadId: 12 });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(participantService.findActiveParticipant).toHaveBeenCalledWith(7, 12);
    expect(
      (ctx.switchToHttp().getRequest() as { threadAccess: unknown }).threadAccess,
    ).toEqual({ threadId: 12, participant });
  });

  it('throws THREAD_NOT_FOUND (non-leaking) when the caller is not an active member', async () => {
    participantService.findActiveParticipant.mockResolvedValueOnce(null);
    const ctx = makeCtx(7, { threadId: 12 });

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      bizCode: BusinessCode.THREAD_NOT_FOUND,
    });
  });

  it('throws VALIDATION_FAILED when threadId is absent (defensive — DTO should have sent it)', async () => {
    const ctx = makeCtx(7, {});
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
    });
    expect(participantService.findActiveParticipant).not.toHaveBeenCalled();
  });
});
