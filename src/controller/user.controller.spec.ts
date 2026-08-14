import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { UserController } from './user.controller.js';

function setup() {
  const queryParticipants = vi.fn();
  const queryDelta = vi.fn();
  const queryProfileDelta = vi.fn().mockResolvedValue([]);
  const queryMemberProfileDelta = vi.fn().mockResolvedValue([]);
  const controller = new UserController(
    { queryUsers: vi.fn().mockResolvedValue([]) } as never,
    { queryParticipants } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      queryDelta,
      queryProfileDelta,
      queryMemberProfileDelta,
    } as never,
    { query: vi.fn().mockResolvedValue([]) } as never,
    {} as never,
    {} as never,
  );
  const req = { user: { userId: 7 } } as unknown as FastifyRequest;
  return {
    controller,
    queryDelta,
    queryParticipants,
    req,
  };
}

describe('UserController.queryThreadDelta', () => {
  it('plans last-op-wins, hydrates only net ADDs, and returns DELETEs id-only', async () => {
    const { controller, queryDelta, queryParticipants, req } = setup();
    queryDelta.mockResolvedValue([
      { threadId: 10, direction: 'DELETE', revision: 2 },
      { threadId: 20, direction: 'ADD', revision: 3 },
      { threadId: 10, direction: 'ADD', revision: 4 },
      { threadId: 30, direction: 'ADD', revision: 5 },
      { threadId: 30, direction: 'DELETE', revision: 6 },
    ]);
    const rows = [{ id: 100 }, { id: 200 }];
    queryParticipants.mockResolvedValue(rows);
    const hydrated = [{ threadId: 10 }, { threadId: 20 }];
    vi.spyOn(controller as never, 'hydrateConversationItems').mockResolvedValue(
      hydrated,
    );

    const result = await controller.queryThreadDelta(req, {
      fromRevision: 1,
      toRevision: 6,
    });

    expect(queryDelta).toHaveBeenCalledWith(7, 1, 6);
    expect(queryParticipants).toHaveBeenCalledWith({
      where: { userId: 7, threadId: { in: [10, 20] } },
      include: { thread: true },
    });
    expect(result).toEqual([
      { threadId: 10, direction: 'ADD', item: hydrated[0] },
      { threadId: 20, direction: 'ADD', item: hydrated[1] },
      { threadId: 30, direction: 'DELETE' },
    ]);
  });

  it('skips participant hydration for a DELETE-only delta', async () => {
    const { controller, queryDelta, queryParticipants, req } = setup();
    queryDelta.mockResolvedValue([
      { threadId: 10, direction: 'DELETE', revision: 2 },
    ]);

    const result = await controller.queryThreadDelta(req, {
      fromRevision: 1,
      toRevision: 2,
    });

    expect(queryParticipants).not.toHaveBeenCalled();
    expect(result).toEqual([{ threadId: 10, direction: 'DELETE' }]);
  });

  it('drops a net ADD when no current participant can be hydrated', async () => {
    const { controller, queryDelta, queryParticipants, req } = setup();
    queryDelta.mockResolvedValue([
      { threadId: 10, direction: 'ADD', revision: 2 },
    ]);
    queryParticipants.mockResolvedValue([]);
    vi.spyOn(controller as never, 'hydrateConversationItems').mockResolvedValue(
      [],
    );

    await expect(
      controller.queryThreadDelta(req, { fromRevision: 1, toRevision: 2 }),
    ).resolves.toEqual([]);
  });
});
