import { describe, expect, it, vi } from 'vitest';
import { DurableTaskAdminController } from './durable-task-admin.controller.js';

describe('DurableTaskAdminController', () => {
  it('returns newest tasks with pagination metadata', async () => {
    const task = {
      id: 9n,
      taskType: 'DISBAND_GROUP',
      scopeType: 'GROUP',
      scopeKey: 'GROUP:!example@local',
      status: 'SUCCEEDED',
    };
    const listQuery = {
      from: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      offset: vi.fn(),
      limit: vi.fn().mockResolvedValue([task]),
    };
    listQuery.from.mockReturnValue(listQuery);
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
    ).resolves.toEqual({ list: [task], total: 1 });
    expect(listQuery.offset).toHaveBeenCalledWith(10);
    expect(listQuery.limit).toHaveBeenCalledWith(25);
  });

});
