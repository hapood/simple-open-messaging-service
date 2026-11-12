import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DurableTaskAdminController } from './durable-task-admin.controller.js';
import { account, durableTask } from '../database/schema.js';

describe('DurableTaskAdminController', () => {
  it('returns newest tasks with pagination metadata and actor kind', async () => {
    const task = {
      id: 9n,
      taskType: 'DISBAND_GROUP',
      scopeType: 'GROUP',
      scopeKey: 'GROUP:!example@local',
      status: 'SUCCEEDED',
    };
    const row = { ...task, actorAccount: 'owner@local' };
    const listQuery = {
      from: vi.fn(),
      leftJoin: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      offset: vi.fn(),
      limit: vi.fn().mockResolvedValue([row]),
    };
    listQuery.from.mockReturnValue(listQuery);
    listQuery.leftJoin.mockReturnValue(listQuery);
    listQuery.where.mockReturnValue(listQuery);
    listQuery.orderBy.mockReturnValue(listQuery);
    listQuery.offset.mockReturnValue(listQuery);
    const countQuery = {
      from: vi.fn(),
      where: vi.fn(),
      then: (resolve: (rows: Array<{ value: number }>) => unknown) =>
        Promise.resolve([{ value: 1 }]).then(resolve),
    };
    countQuery.from.mockReturnValue(countQuery);
    countQuery.where.mockReturnValue(countQuery);
    const select = vi
      .fn()
      .mockReturnValueOnce(listQuery)
      .mockReturnValueOnce(countQuery);
    const controller = new DurableTaskAdminController({
      db: { select },
    } as never);

    await expect(
      controller.list({ skip: 10, take: 25, status: 'SUCCEEDED' }),
    ).resolves.toEqual({ list: [row], total: 1 });
    expect(listQuery.offset).toHaveBeenCalledWith(10);
    expect(listQuery.limit).toHaveBeenCalledWith(25);
    expect(listQuery.leftJoin).toHaveBeenCalledWith(
      account,
      eq(durableTask.actorUserId, account.id),
    );
  });
});
