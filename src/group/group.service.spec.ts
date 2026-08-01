import { describe, expect, it, vi } from 'vitest';
import { GroupRole } from '../database/enums.js';
import { group, messageThread, threadParticipant } from '../database/schema.js';
import { BusinessCode } from '../common/business-code.js';
import { GroupService } from './group.service.js';

type SelectResult = unknown[];

function createTx(options: {
  selects: SelectResult[];
  updateResults?: unknown[][];
}) {
  const selects = [...options.selects];
  const updateResults = [...(options.updateResults ?? [])];
  const sets: unknown[] = [];
  const select = vi.fn(() => {
    const result = selects.shift() ?? [];
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn(() => Promise.resolve(result)),
      then: (resolve: (value: unknown[]) => unknown) =>
        Promise.resolve(result).then(resolve),
    };
    return query;
  });
  const update = vi.fn((table: unknown) => {
    const returningResult = updateResults.shift() ?? [];
    const query = {
      set: vi.fn((value: unknown) => {
        sets.push({ table, value });
        return query;
      }),
      where: vi.fn(() => query),
      returning: vi.fn(() => Promise.resolve(returningResult)),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve),
    };
    return query;
  });
  return { select, update, sets };
}

function createService(tx: ReturnType<typeof createTx>, revisions: object) {
  const database = {
    db: { transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) },
  };
  return new GroupService(database as never, revisions as never);
}

describe('GroupService membership lifecycle', () => {
  it('rejects an owner leaving while another active member remains', async () => {
    const tx = createTx({
      selects: [[{ leftAt: null, role: GroupRole.OWNER }], [{ value: 2 }]],
    });
    const revisions = { isThreadHiddenInTx: vi.fn() };
    const service = createService(tx, revisions);

    await expect(
      service.leaveGroup({
        userId: 1,
        threadId: 10,
        role: GroupRole.OWNER,
        deleteData: false,
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.GROUP_OWNER_MUST_TRANSFER,
    });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('marks a group dissolved and revokes pending invites while retaining history membership', async () => {
    const tx = createTx({
      selects: [[{ groupUserId: 99 }]],
      updateResults: [[{ id: 1 }], []],
    });
    const revisions = { recordThreadDeleteInTx: vi.fn() };
    const service = createService(tx, revisions);

    await expect(service.dissolveGroup({ threadId: 10 })).resolves.toEqual({
      transitioned: true,
    });
    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(tx.update).toHaveBeenNthCalledWith(1, group);
    expect(tx.sets[0]).toMatchObject({
      table: group,
      value: { dissolvedAt: expect.any(Date), updatedAt: expect.any(Date) },
    });
    expect(revisions.recordThreadDeleteInTx).not.toHaveBeenCalled();
  });

  it('treats dissolving an already dissolved group as an idempotent success', async () => {
    const tx = createTx({ selects: [[{ groupUserId: 99 }]], updateResults: [[]] });
    const service = createService(tx, {});

    await expect(service.dissolveGroup({ threadId: 10 })).resolves.toEqual({
      transitioned: false,
    });
    expect(tx.update).toHaveBeenCalledTimes(1);
  });

  it('keeps a kicked member history-visible and makes a repeat a no-op', async () => {
    const target = { id: 8, role: GroupRole.MEMBER, leftAt: null as Date | null };
    const tx = createTx({
      selects: [
        [{ id: 7, role: GroupRole.OWNER, leftAt: null }],
        [target],
        [{ groupUserId: 99 }],
        [{ id: 7, role: GroupRole.OWNER, leftAt: null }],
        [target],
      ],
      updateResults: [[{ id: 8 }], []],
    });
    const revisions = {
      isThreadHiddenInTx: vi.fn().mockResolvedValue(false),
      recordThreadAddInTx: vi.fn().mockResolvedValue(5),
      notifyThreadRevision: vi.fn(),
    };
    const service = createService(tx, revisions);

    await expect(
      service.kickMember({ threadId: 10, operatorUserId: 1, targetUserId: 2 }),
    ).resolves.toEqual({ transitioned: true });
    expect(revisions.recordThreadAddInTx).toHaveBeenCalledWith(tx, 2, 10);
    expect(revisions.notifyThreadRevision).toHaveBeenCalledWith({ userId: 2, revision: 5 });

    target.leftAt = new Date();
    await expect(
      service.kickMember({ threadId: 10, operatorUserId: 1, targetUserId: 2 }),
    ).resolves.toEqual({ transitioned: false });
    expect(tx.update).toHaveBeenCalledTimes(2);
  });

  it('does not publish SSE when a kick transaction rejects after writing its revision', async () => {
    const tx = createTx({
      selects: [
        [{ id: 7, role: GroupRole.OWNER, leftAt: null }],
        [{ id: 8, role: GroupRole.MEMBER, leftAt: null }],
        [{ groupUserId: 99 }],
      ],
      updateResults: [[{ id: 8 }], []],
    });
    const rollback = new Error('revision write failed');
    const revisions = {
      isThreadHiddenInTx: vi.fn().mockResolvedValue(false),
      recordThreadAddInTx: vi.fn().mockRejectedValue(rollback),
      notifyThreadRevision: vi.fn(),
    };
    const service = createService(tx, revisions);

    await expect(
      service.kickMember({ threadId: 10, operatorUserId: 1, targetUserId: 2 }),
    ).rejects.toBe(rollback);
    expect(revisions.notifyThreadRevision).not.toHaveBeenCalled();
  });
});
