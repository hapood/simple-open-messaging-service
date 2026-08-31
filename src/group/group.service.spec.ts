import { describe, expect, it, vi } from 'vitest';
import { GroupRole } from '../database/enums.js';
import { group, threadMember } from '../database/schema.js';
import { BusinessCode } from '../common/business-code.js';
import { GroupService } from './group.service.js';

type SelectResult = unknown[];

function createTx(options: {
  selects: SelectResult[];
  updateResults?: unknown[][];
  deleteResults?: unknown[][];
  userDomain?: string;
}) {
  const selects = [...options.selects];
  const updateResults = [...(options.updateResults ?? [])];
  const deleteResults = [...(options.deleteResults ?? [])];
  const sets: unknown[] = [];
  const select = vi.fn(() => {
    const result = selects.shift() ?? [];
    const query = {
      from: vi.fn(() => query),
      innerJoin: vi.fn(() => query),
      leftJoin: vi.fn(() => query),
      where: vi.fn(() => query),
      for: vi.fn(() => query),
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
  const deleteFrom = vi.fn(() => {
    const returningResult = deleteResults.shift() ?? [];
    const query = {
      where: vi.fn(() => query),
      returning: vi.fn(() => Promise.resolve(returningResult)),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve),
    };
    return query;
  });
  const execute = vi.fn().mockResolvedValue({ rows: [{ authorized: true }] });
  return {
    select,
    update,
    delete: deleteFrom,
    execute,
    sets,
    query: {
      user: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            options.userDomain ? { domain: options.userDomain } : undefined,
          ),
      },
    },
  };
}

function createService(
  tx: ReturnType<typeof createTx>,
  federationOverrides: object,
  messages?: object,
  messageFanout?: object,
) {
  const database = {
    db: {
      transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
  };
  const federation = {
    lockGroupMutationInTx: vi.fn().mockResolvedValue(undefined),
    writeGroupStateInTx: vi.fn().mockResolvedValue(new Map()),
    writeMemberRelationshipIntentInTx: vi.fn().mockResolvedValue(new Map()),
    writeGroupRelationshipIntentInTx: vi.fn().mockResolvedValue(new Map()),
    reconcileGroupJoinRequestManagerInTx: vi.fn().mockResolvedValue(undefined),
    notifyGroupLeave: vi.fn().mockResolvedValue(undefined),
    pushStateFeedDomains: vi.fn().mockResolvedValue(undefined),
    ...federationOverrides,
  };
  const clientStateFeed = {
    recordGroupStateInTx: vi.fn().mockResolvedValue([]),
    notifyFeedUpdated: vi.fn(),
    notifyFeedUpdates: vi.fn(),
  };
  return new GroupService(
    database as never,
    federation as never,
    federation as never,
    clientStateFeed as never,
    messages as never,
    messageFanout as never,
  );
}

describe('GroupService membership lifecycle', () => {
  it('rejects administrator role changes when the operator is only an admin', async () => {
    const transaction = vi.fn();
    const database = {
      db: {
        query: {
          threadMember: {
            findFirst: vi.fn().mockResolvedValue({ role: GroupRole.ADMIN }),
          },
        },
        transaction,
      },
    };
    const service = new GroupService(
      database as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.setRole({
        threadId: 10,
        targetUserId: 2,
        role: GroupRole.ADMIN,
        operatorUserId: 1,
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.GROUP_FORBIDDEN });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects an owner leaving while another active member remains', async () => {
    const tx = createTx({
      selects: [
        [
          {
            role: GroupRole.OWNER,
            groupId: 99,
            groupDomain: 'local',
          },
        ],
        [{ value: 2 }],
      ],
    });
    const service = createService(tx, {});

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

  it('immediately garbage-collects manager projections when an administrator leaves', async () => {
    const tx = createTx({
      selects: [
        [
          {
            role: GroupRole.ADMIN,
            groupId: 99,
            groupDomain: 'local',
          },
        ],
        [],
        [{ groupId: 99 }],
        [],
      ],
    });
    tx.execute
      .mockResolvedValueOnce({ rows: [{ authorized: true }] })
      .mockResolvedValue({ rows: [{ authorized: false }] });
    const reconcileGroupJoinRequestManagerInTx = vi
      .fn()
      .mockResolvedValue(undefined);
    const service = createService(tx, {
      reconcileGroupJoinRequestManagerInTx,
    });

    await service.leaveGroup({
      userId: 2,
      threadId: 10,
      role: GroupRole.ADMIN,
      deleteData: false,
    });

    expect(reconcileGroupJoinRequestManagerInTx).toHaveBeenCalledWith(
      tx,
      10,
      2,
      expect.any(Array),
    );
  });

  it('revokes both directions when a member leaves a local group', async () => {
    const tx = createTx({
      selects: [
        [
          {
            role: GroupRole.MEMBER,
            groupId: 99,
            groupDomain: 'local',
          },
        ],
        [],
        [{ groupId: 99 }],
        [],
      ],
    });
    const writeMemberRelationshipIntentInTx = vi
      .fn()
      .mockResolvedValue(new Map());
    const writeGroupRelationshipIntentInTx = vi
      .fn()
      .mockResolvedValue(new Map());
    const service = createService(tx, {
      writeMemberRelationshipIntentInTx,
      writeGroupRelationshipIntentInTx,
    });

    await service.leaveGroup({
      userId: 2,
      threadId: 10,
      role: GroupRole.MEMBER,
      deleteData: false,
    });

    expect(writeMemberRelationshipIntentInTx).toHaveBeenCalledWith(
      tx,
      10,
      2,
      'REVOKED',
      expect.any(Array),
      '',
      undefined,
      { publishGroupState: true, allowOwnerDeactivation: false },
    );
    expect(writeGroupRelationshipIntentInTx).toHaveBeenCalledWith(
      tx,
      10,
      2,
      '',
      'REVOKED',
      expect.any(Array),
      undefined,
      { publishGroupState: true, allowOwnerDeactivation: false },
    );
  });

  it('commits only the terminal group marker before member fan-out', async () => {
    const tx = createTx({
      selects: [[{ groupId: 99, groupDomain: 'local', role: GroupRole.OWNER }]],
      updateResults: [[{ id: 1 }]],
    });
    const service = createService(tx, {});

    await expect(
      service.markGroupDissolved({ threadId: 10, operatorUserId: 1 }),
    ).resolves.toEqual({ transitioned: true });
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledWith(group);
    expect(tx.sets[0]).toMatchObject({
      table: group,
      value: { dissolvedAt: expect.any(Date), updatedAt: expect.any(Date) },
    });
  });

  it('treats an already committed terminal marker as idempotent', async () => {
    const tx = createTx({
      selects: [[{ groupId: 99, groupDomain: 'local', role: GroupRole.OWNER }]],
      updateResults: [[]],
    });
    const service = createService(tx, {});

    await expect(
      service.markGroupDissolved({ threadId: 10, operatorUserId: 1 }),
    ).resolves.toEqual({ transitioned: false });
    expect(tx.update).toHaveBeenCalledTimes(1);
  });

  it('delegates each dissolved member to the existing leave transaction in fan-out mode', async () => {
    const tx = createTx({ selects: [] });
    const service = createService(tx, {});
    const leaveGroup = vi
      .spyOn(service, 'leaveGroup')
      .mockResolvedValue({ transitioned: true, remainingMemberIds: [] });

    await service.revokeDissolvedGroupMember({
      threadId: 10,
      memberUserId: 2,
      deleteData: true,
    });

    expect(leaveGroup).toHaveBeenCalledWith({
      userId: 2,
      threadId: 10,
      role: null,
      deleteData: true,
      dissolvedFanout: true,
    });
  });

  it('allows owner projection deactivation only during dissolved fan-out', async () => {
    const tx = createTx({
      selects: [
        [
          {
            groupId: 99,
            groupDomain: 'local',
            dissolvedAt: new Date(),
          },
        ],
      ],
      userDomain: 'local',
    });
    const writeMemberRelationshipIntentInTx = vi
      .fn()
      .mockResolvedValue(new Map());
    const writeGroupRelationshipIntentInTx = vi
      .fn()
      .mockResolvedValue(new Map());
    const service = createService(tx, {
      writeMemberRelationshipIntentInTx,
      writeGroupRelationshipIntentInTx,
    });

    await service.leaveGroup({
      userId: 2,
      threadId: 10,
      role: null,
      deleteData: false,
      dissolvedFanout: true,
    });

    expect(writeMemberRelationshipIntentInTx).toHaveBeenCalledWith(
      tx,
      10,
      2,
      'REVOKED',
      expect.any(Array),
      '',
      undefined,
      { publishGroupState: false, allowOwnerDeactivation: true },
    );
    expect(writeGroupRelationshipIntentInTx).toHaveBeenCalledWith(
      tx,
      10,
      2,
      '',
      'REVOKED',
      expect.any(Array),
      undefined,
      { publishGroupState: false, allowOwnerDeactivation: true },
    );
  });

  it.each([GroupRole.ADMIN, GroupRole.OWNER])(
    'does not allow an admin to kick a %s',
    async (targetRole) => {
      const tx = createTx({
        selects: [
          [{ id: 7, role: GroupRole.ADMIN }],
          [
            {
              member: { id: 8, role: targetRole },
              domain: 'local',
            },
          ],
        ],
      });
      const service = createService(tx, {});

      await expect(
        service.kickMember({
          threadId: 10,
          operatorUserId: 1,
          targetUserId: 2,
        }),
      ).rejects.toMatchObject({ bizCode: BusinessCode.GROUP_FORBIDDEN });
      expect(tx.update).not.toHaveBeenCalled();
    },
  );

  it('revokes a kicked participant and makes an absent repeat a no-op', async () => {
    const target = {
      id: 8,
      role: GroupRole.MEMBER,
    };
    const tx = createTx({
      selects: [
        [
          {
            id: 7,
            role: GroupRole.OWNER,
          },
        ],
        [{ member: target, domain: 'local' }],
        [{ userId: 1 }, { userId: 2 }],
        [{ groupId: 99 }],
        [
          {
            id: 7,
            role: GroupRole.OWNER,
          },
        ],
        [],
      ],
      updateResults: [[{ id: 8 }], []],
    });
    const systemMessage = {
      threadId: 10,
      seq: 9,
      creator: null,
      createdAt: new Date(),
    };
    const messages = {
      writeSystemMessageInTx: vi
        .fn()
        .mockResolvedValue({ message: systemMessage }),
    };
    const messageFanout = { dispatchToUsers: vi.fn() };
    const service = createService(tx, {}, messages, messageFanout);

    await expect(
      service.kickMember({ threadId: 10, operatorUserId: 1, targetUserId: 2 }),
    ).resolves.toEqual({ transitioned: true });
    expect(messages.writeSystemMessageInTx).toHaveBeenCalledWith(
      tx,
      10,
      'GROUP_LEFT',
      2,
      {
        actorUserId: 1,
        markReadUserId: 1,
        recipientUserIds: [1, 2],
      },
    );
    expect(messageFanout.dispatchToUsers).toHaveBeenCalledWith(
      systemMessage,
      [1, 2],
    );

    await expect(
      service.kickMember({ threadId: 10, operatorUserId: 1, targetUserId: 2 }),
    ).resolves.toEqual({ transitioned: false });
    expect(messages.writeSystemMessageInTx).toHaveBeenCalledTimes(1);
  });

  it('does not publish effects when a kick transaction rejects during state-feed projection', async () => {
    const tx = createTx({
      selects: [
        [
          {
            id: 7,
            role: GroupRole.OWNER,
          },
        ],
        [
          {
            member: {
              id: 8,
              role: GroupRole.MEMBER,
            },
            domain: 'local',
          },
        ],
        [{ userId: 1 }, { userId: 2 }],
        [{ groupId: 99 }],
      ],
      updateResults: [[{ id: 8 }], []],
    });
    const rollback = new Error('group state write failed');
    const federation = {
      writeGroupStateInTx: vi.fn().mockRejectedValue(rollback),
    };
    const service = createService(tx, federation);

    await expect(
      service.kickMember({ threadId: 10, operatorUserId: 1, targetUserId: 2 }),
    ).rejects.toBe(rollback);
  });
});
