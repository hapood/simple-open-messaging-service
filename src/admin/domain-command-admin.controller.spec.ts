import { describe, expect, it, vi } from 'vitest';
import { DomainCommandAdminController } from './domain-command-admin.controller.js';

describe('DomainCommandAdminController', () => {
  it('returns newest commands with pagination metadata', async () => {
    const command = {
      id: 9n,
      commandType: 'DISBAND_GROUP',
      aggregateType: 'GROUP',
      aggregateKey: 'GROUP:!example@local',
      status: 'SUCCEEDED',
    };
    const listQuery = {
      from: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      offset: vi.fn(),
      limit: vi.fn().mockResolvedValue([command]),
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
    const controller = new DomainCommandAdminController({
      db: { select },
    } as never);

    await expect(
      controller.list({ skip: 10, take: 25, status: 'SUCCEEDED' }),
    ).resolves.toEqual({ list: [command], total: 1 });
    expect(listQuery.offset).toHaveBeenCalledWith(10);
    expect(listQuery.limit).toHaveBeenCalledWith(25);
  });
});
