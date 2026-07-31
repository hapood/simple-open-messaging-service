import { describe, expect, it, vi } from 'vitest';
import {
  GroupRole,
  InviteKind,
  InviteStatus,
} from '../prisma/generated/client.js';
import { BusinessCode } from '../common/business-code.js';
import { GroupService } from './group.service.js';

describe('GroupService membership lifecycle', () => {
  it('rejects an owner leaving while another active member remains', async () => {
    const tx = {
      threadParticipant: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ leftAt: null, role: GroupRole.OWNER }),
        count: vi.fn().mockResolvedValue(2),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const revisions = {
      isThreadHidden: vi.fn(),
      recordThreadDelete: vi.fn(),
    };
    const service = new GroupService(prisma as never, revisions as never);

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
    expect(tx.threadParticipant.updateMany).not.toHaveBeenCalled();
    expect(revisions.recordThreadDelete).not.toHaveBeenCalled();
  });

  it('marks a group dissolved and revokes pending invites while retaining history membership', async () => {
    const tx = {
      messageThread: {
        findUnique: vi.fn().mockResolvedValue({
          groupUserId: 99,
        }),
      },
      group: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      invite: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const revisions = {
      recordThreadDelete: vi.fn().mockResolvedValue(undefined),
    };
    const service = new GroupService(prisma as never, revisions as never);

    await expect(service.dissolveGroup({ threadId: 10 })).resolves.toEqual({
      transitioned: true,
    });
    expect(tx.group.updateMany).toHaveBeenCalledWith({
      where: { groupUserId: 99, dissolvedAt: null },
      data: { dissolvedAt: expect.any(Date), rosterRev: { increment: 1 } },
    });
    expect(tx.invite.updateMany).toHaveBeenCalledWith({
      where: {
        kind: InviteKind.GROUP,
        threadId: 10,
        status: InviteStatus.PENDING,
      },
      data: { status: InviteStatus.REVOKED },
    });
    expect(revisions.recordThreadDelete).not.toHaveBeenCalled();
  });

  it('treats dissolving an already dissolved group as an idempotent success', async () => {
    const tx = {
      messageThread: {
        findUnique: vi.fn().mockResolvedValue({
          groupUserId: 99,
        }),
      },
      group: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      invite: { updateMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const service = new GroupService(prisma as never, {} as never);

    await expect(service.dissolveGroup({ threadId: 10 })).resolves.toEqual({
      transitioned: false,
    });
    expect(tx.group.updateMany).toHaveBeenCalledWith({
      where: { groupUserId: 99, dissolvedAt: null },
      data: { dissolvedAt: expect.any(Date), rosterRev: { increment: 1 } },
    });
    expect(tx.invite.updateMany).not.toHaveBeenCalled();
  });

  it('keeps a kicked member history-visible and makes a repeat a no-op', async () => {
    const target = {
      id: 8,
      role: GroupRole.MEMBER,
      leftAt: null as Date | null,
    };
    const tx = {
      threadParticipant: {
        findUnique: vi
          .fn()
          .mockImplementation(async (args) =>
            args.where.userId_threadId.userId === 1
              ? { id: 7, role: GroupRole.OWNER, leftAt: null }
              : { ...target },
          ),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
      },
      messageThread: {
        findUnique: vi.fn().mockResolvedValue({ groupUserId: 99 }),
      },
      group: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const revisions = {
      isThreadHiddenInTx: vi.fn().mockResolvedValue(false),
      recordThreadAddInTx: vi.fn().mockResolvedValue(5),
      notifyThreadRevision: vi.fn(),
    };
    const service = new GroupService(prisma as never, revisions as never);

    await expect(
      service.kickMember({
        threadId: 10,
        operatorUserId: 1,
        targetUserId: 2,
      }),
    ).resolves.toEqual({ transitioned: true });
    expect(revisions.recordThreadAddInTx).toHaveBeenCalledWith(tx, 2, 10);
    expect(revisions.notifyThreadRevision).toHaveBeenCalledWith({
      userId: 2,
      revision: 5,
    });

    target.leftAt = new Date();
    await expect(
      service.kickMember({
        threadId: 10,
        operatorUserId: 1,
        targetUserId: 2,
      }),
    ).resolves.toEqual({ transitioned: false });
    expect(tx.threadParticipant.updateMany).toHaveBeenCalledTimes(1);
  });

  it('does not publish SSE when a kick transaction rejects after writing its revision', async () => {
    const tx = {
      threadParticipant: {
        findUnique: vi
          .fn()
          .mockImplementation(async (args) =>
            args.where.userId_threadId.userId === 1
              ? { id: 7, role: GroupRole.OWNER, leftAt: null }
              : { id: 8, role: GroupRole.MEMBER, leftAt: null },
          ),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      messageThread: {
        findUnique: vi.fn().mockResolvedValue({ groupUserId: 99 }),
      },
      group: { update: vi.fn().mockResolvedValue({}) },
    };
    const rollback = new Error('revision write failed');
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const revisions = {
      isThreadHiddenInTx: vi.fn().mockResolvedValue(false),
      recordThreadAddInTx: vi.fn().mockRejectedValue(rollback),
      notifyThreadRevision: vi.fn(),
    };
    const service = new GroupService(prisma as never, revisions as never);

    await expect(
      service.kickMember({
        threadId: 10,
        operatorUserId: 1,
        targetUserId: 2,
      }),
    ).rejects.toBe(rollback);
    expect(revisions.notifyThreadRevision).not.toHaveBeenCalled();
  });
});
