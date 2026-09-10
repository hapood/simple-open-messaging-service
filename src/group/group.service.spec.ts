import { enqueueReverseGroupRevokeInTx } from '../relationship/reverse-revoke-task.js';
import { describe, expect, it, vi } from 'vitest';
import { GroupRole } from '../database/enums.js';
import { groupAccount as group, profileTable } from '../database/schema.js';
import { BusinessCode } from '../common/business-code.js';
import { GroupService } from './group.service.js';

vi.mock('../relationship/reverse-revoke-task.js', () => ({
  enqueueReverseGroupRevokeInTx: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../user/account-address.js', () => ({
  accountAddressInTx: async (_tx: unknown, target: number | object) =>
    typeof target === 'number'
      ? { account: `u${target}`, domain: 'local', namespaceId: 0 }
      : target,
  localAccountsForTargetsInTx: async (_tx: unknown, targets: number[]) =>
    targets.map((id) => ({
      id,
      account: `u${id}`,
      domain: 'local',
      namespaceId: 0,
    })),
}));
type SelectResult = unknown[];

function createTx(options: {
  selects: SelectResult[];
  insertResults?: unknown[][];
  updateResults?: unknown[][];
  deleteResults?: unknown[][];
  userDomain?: string;
  executeResults?: Array<{ rows: unknown[] }>;
}) {
  const selects = [...options.selects];
  const insertResults = [...(options.insertResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];
  const deleteResults = [...(options.deleteResults ?? [])];
  const sets: unknown[] = [];
  const inserted: Array<{ table: unknown; value: unknown }> = [];
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
  const insert = vi.fn((table: unknown) => {
    const returningResult = insertResults.shift() ?? [];
    const query = {
      values: vi.fn((value: unknown) => {
        inserted.push({ table, value });
        return query;
      }),
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
  const executeResults = [...(options.executeResults ?? [])];
  const execute = vi.fn(() =>
    Promise.resolve(executeResults.shift() ?? { rows: [{ authorized: true }] }),
  );
  return {
    select,
    insert,
    update,
    delete: deleteFrom,
    execute,
    sets,
    inserted,
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
  authoritativeGroupMetaOverrides: object = {},
) {
  const database = {
    db: {
      transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
  };
  const federation = {
    lockMemberRelationshipFeedInTx: vi.fn().mockResolvedValue(undefined),
    lockGroupMutationInTx: vi
      .fn()
      .mockResolvedValue({ threadLock: { threadId: 10 } }),
    writeMemberRelationshipIntentInTx: vi.fn().mockResolvedValue(new Map()),
    writeGroupRelationshipIntentInTx: vi.fn().mockResolvedValue(new Map()),
    reconcileGroupJoinRequestManagerInTx: vi.fn().mockResolvedValue(undefined),
    notifyGroupLeave: vi.fn().mockResolvedValue(undefined),
    pushStateFeedDomains: vi.fn().mockResolvedValue(undefined),
    ...federationOverrides,
  };
  const clientStateFeed = {
    notifyFeedUpdated: vi.fn(),
    notifyFeedUpdates: vi.fn(),
  };
  const authoritativeGroupMeta = {
    applyRoleFactsInTx: vi.fn().mockResolvedValue(undefined),
    applyProfileFactInTx: vi.fn().mockResolvedValue(undefined),
    finalizeInTx: vi.fn().mockResolvedValue(undefined),
    ...authoritativeGroupMetaOverrides,
  };
  const service = new GroupService(
    database as never,
    federation as never,
    federation as never,
    clientStateFeed as never,
    authoritativeGroupMeta as never,
    messages as never,
  );
  return service;
}

describe('GroupService membership lifecycle', () => {
  it('rejects administrator role changes when the operator is only an admin', async () => {
    const tx = createTx({
      selects: [
        [
          {
            groupId: 5,
            groupAccount: '!group',
            groupDomain: 'local',
            namespaceId: 0,
            dissolvedAt: null,
          },
        ],
      ],
      executeResults: [
        {
          rows: [
            {
              userId: 1,
              account: 'owner',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.ADMIN,
              profileRev: 3,
              available: true,
            },
          ],
        },
      ],
    });
    const service = createService(tx, {});

    await expect(
      service.setRole({
        threadId: 10,
        targetUserId: 2,
        role: GroupRole.ADMIN,
        operatorUserId: 1,
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.GROUP_FORBIDDEN });
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('admits role fan-out after the dependent manager projection', async () => {
    const tx = createTx({
      selects: [
        [
          {
            groupId: 5,
            groupAccount: '!group',
            groupDomain: 'local',
            namespaceId: 0,
            dissolvedAt: null,
          },
        ],
      ],
      executeResults: [
        {
          rows: [
            {
              userId: 1,
              account: 'owner',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.OWNER,
              profileRev: 3,
              available: true,
            },
          ],
        },
        { rows: [{ authorized: true }] },
        {
          rows: [
            {
              userId: 2,
              account: 'member',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.MEMBER,
              profileRev: 6,
              available: true,
            },
          ],
        },
        { rows: [{ authorized: true }] },
      ],
    });
    const applyRoleFactsInTx = vi.fn().mockResolvedValue(undefined);
    const finalizeInTx = vi.fn().mockResolvedValue(undefined);
    const reconcileGroupJoinRequestManagerInTx = vi
      .fn()
      .mockResolvedValue(undefined);
    const service = createService(
      tx,
      { reconcileGroupJoinRequestManagerInTx },
      undefined,
      { applyRoleFactsInTx, finalizeInTx },
    );

    await service.setRole({
      threadId: 10,
      targetUserId: 2,
      role: GroupRole.ADMIN,
      operatorUserId: 1,
    });

    expect(applyRoleFactsInTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        threadId: 10,
        groupId: 5,
        changes: [
          expect.objectContaining({
            role: GroupRole.ADMIN,
            member: expect.objectContaining({ profileRev: 6 }),
          }),
        ],
      }),
    );
    expect(applyRoleFactsInTx.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileGroupJoinRequestManagerInTx.mock.invocationCallOrder[0],
    );
    expect(
      reconcileGroupJoinRequestManagerInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(finalizeInTx.mock.invocationCallOrder[0]);
  });

  it('writes a changed group profile fact and then admits head fan-out', async () => {
    const current = {
      id: 99,
      account: '!group',
      domain: 'local',
      namespaceId: 0,
      name: 'Old name',
      description: 'Old bio',
      avatar: 'old-avatar',
      profileRev: 3,
      dissolvedAt: null,
    };
    const updated = {
      ...current,
      name: 'New name',
      description: 'New bio',
      profileRev: 4,
    };
    const tx = createTx({
      selects: [[{ group: current }], [{ groupId: 99 }], [updated]],
      updateResults: [[updated]],
      executeResults: [
        {
          rows: [
            {
              userId: 1,
              account: 'owner',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.OWNER,
              profileRev: 2,
              available: true,
            },
          ],
        },
        { rows: [{ authorized: true }] },
      ],
    });
    const applyProfileFactInTx = vi.fn().mockResolvedValue(undefined);
    const finalizeInTx = vi.fn().mockResolvedValue(undefined);
    const service = createService(tx, {}, undefined, {
      applyProfileFactInTx,
      finalizeInTx,
    });

    await expect(
      service.updateGroup({
        threadId: 10,
        operatorUserId: 1,
        name: 'New name',
        description: 'New bio',
      }),
    ).resolves.toBe(updated);

    expect(tx.inserted).toEqual([
      {
        table: profileTable,
        value: {
          account: '!group',
          domain: 'local',
          namespaceId: 0,
          profileRev: 4,
          displayName: 'New name',
          avatar: 'old-avatar',
          bio: 'New bio',
        },
      },
    ]);
    expect(applyProfileFactInTx).toHaveBeenCalledWith(tx, 99, 4);
    expect(finalizeInTx).toHaveBeenCalledWith(tx, {
      threadId: 10,
      groupAccount: '!group',
    });
    expect(applyProfileFactInTx.mock.invocationCallOrder[0]).toBeLessThan(
      finalizeInTx.mock.invocationCallOrder[0],
    );
  });

  it('does not allocate a profile revision for an unchanged group profile', async () => {
    const current = {
      id: 99,
      account: '!group',
      domain: 'local',
      namespaceId: 0,
      name: 'Same name',
      description: 'Same bio',
      avatar: 'same-avatar',
      profileRev: 3,
      dissolvedAt: null,
    };
    const tx = createTx({
      selects: [[{ group: current }], [{ groupId: 99 }]],
      executeResults: [
        {
          rows: [
            {
              userId: 1,
              account: 'owner',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.ADMIN,
              profileRev: 2,
              available: true,
            },
          ],
        },
        { rows: [{ authorized: true }] },
      ],
    });
    const applyProfileFactInTx = vi.fn().mockResolvedValue(undefined);
    const finalizeInTx = vi.fn().mockResolvedValue(undefined);
    const service = createService(tx, {}, undefined, {
      applyProfileFactInTx,
      finalizeInTx,
    });

    await expect(
      service.updateGroup({
        threadId: 10,
        operatorUserId: 1,
        name: 'Same name',
      }),
    ).resolves.toBe(current);

    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(applyProfileFactInTx).not.toHaveBeenCalled();
    expect(finalizeInTx).not.toHaveBeenCalled();
  });

  it('rejects an owner leaving while another active member remains', async () => {
    const tx = createTx({
      selects: [
        [
          {
            groupId: 99,
            groupDomain: 'local',
            dissolvedAt: null,
          },
        ],
      ],
      executeResults: [
        {
          rows: [
            {
              userId: 1,
              account: 'owner',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.OWNER,
              profileRev: 1,
              available: true,
            },
          ],
        },
        { rows: [{ status: 'ACCEPTED', active: true }] },
      ],
    });
    const service = createService(tx, {});

    await expect(
      service.leaveGroup({
        userId: 1,
        threadId: 10,
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
            groupId: 99,
            groupDomain: 'local',
            dissolvedAt: null,
          },
        ],
      ],
      executeResults: [
        {
          rows: [
            {
              userId: 2,
              account: 'admin',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.ADMIN,
              profileRev: 1,
              available: true,
            },
          ],
        },
        { rows: [{ status: 'ACCEPTED', active: true }] },
        { rows: [] },
      ],
    });
    const reconcileGroupJoinRequestManagerInTx = vi
      .fn()
      .mockResolvedValue(undefined);
    const service = createService(tx, {
      reconcileGroupJoinRequestManagerInTx,
    });

    await service.leaveGroup({
      userId: 2,
      threadId: 10,
    });

    expect(reconcileGroupJoinRequestManagerInTx).toHaveBeenCalledWith(
      tx,
      10,
      { account: 'u2', domain: 'local', namespaceId: 0 },
      expect.any(Array),
    );
  });

  it('revokes the member direction and queues the group response', async () => {
    const tx = createTx({
      selects: [
        [
          {
            groupId: 99,
            groupDomain: 'local',
            dissolvedAt: null,
          },
        ],
      ],
      executeResults: [
        {
          rows: [
            {
              userId: 2,
              account: 'member',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.MEMBER,
              profileRev: 2,
              available: true,
            },
          ],
        },
        { rows: [{ status: 'ACCEPTED', active: true }] },
        { rows: [] },
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
    });

    expect(writeMemberRelationshipIntentInTx).toHaveBeenCalledWith(
      tx,
      10,
      { account: 'u2', domain: 'local', namespaceId: 0 },
      'REVOKED',
      expect.any(Array),
      '',
      undefined,
      { publishGroupState: true, allowOwnerDeactivation: false },
    );
    expect(writeGroupRelationshipIntentInTx).not.toHaveBeenCalled();
    expect(enqueueReverseGroupRevokeInTx).toHaveBeenCalledWith(
      tx,
      undefined,
      expect.objectContaining({ threadId: 10, author: 'GROUP' }),
    );
  });

  it('commits only the terminal group marker before member fan-out', async () => {
    const tx = createTx({
      selects: [
        [
          {
            groupId: 99,
            groupDomain: 'local',
            namespaceId: 0,
            dissolvedAt: null,
          },
        ],
      ],
      updateResults: [[{ id: 1 }]],
      executeResults: [
        {
          rows: [
            {
              userId: 1,
              account: 'owner',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.OWNER,
              profileRev: 1,
              available: true,
            },
          ],
        },
        { rows: [{ authorized: true }] },
      ],
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
      selects: [
        [
          {
            groupId: 99,
            groupDomain: 'local',
            namespaceId: 0,
            dissolvedAt: new Date(),
          },
        ],
      ],
      executeResults: [
        {
          rows: [
            {
              userId: 1,
              account: 'owner',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.OWNER,
              profileRev: 1,
              available: true,
            },
          ],
        },
      ],
    });
    const service = createService(tx, {});

    await expect(
      service.markGroupDissolved({ threadId: 10, operatorUserId: 1 }),
    ).resolves.toEqual({ transitioned: false });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('delegates each dissolved member to the existing leave transaction in fan-out mode', async () => {
    const tx = createTx({ selects: [] });
    const service = createService(tx, {});
    const leaveGroup = vi
      .spyOn(service, 'leaveGroup')
      .mockResolvedValue({ transitioned: true });

    await service.revokeDissolvedGroupMember({
      threadId: 10,
      memberUserId: 2,
    });

    expect(leaveGroup).toHaveBeenCalledWith({
      userId: 2,
      threadId: 10,
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
      executeResults: [
        {
          rows: [
            {
              userId: 2,
              account: 'member',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.OWNER,
              profileRev: 1,
              available: true,
            },
          ],
        },
        { rows: [{ status: 'ACCEPTED', active: true }] },
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
      dissolvedFanout: true,
    });

    expect(writeMemberRelationshipIntentInTx).toHaveBeenCalledWith(
      tx,
      10,
      { account: 'u2', domain: 'local', namespaceId: 0 },
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
          [
            {
              groupId: 99,
              groupDomain: 'local',
              namespaceId: 0,
              dissolvedAt: null,
            },
          ],
        ],
        executeResults: [
          {
            rows: [
              {
                userId: 1,
                account: 'admin',
                domain: 'local',
                namespaceId: 0,
                role: GroupRole.ADMIN,
                profileRev: 1,
                available: true,
              },
            ],
          },
          {
            rows: [
              {
                userId: 2,
                account: 'target',
                domain: 'local',
                namespaceId: 0,
                role: targetRole,
                profileRev: 2,
                available: true,
              },
            ],
          },
          { rows: [{ authorized: true }] },
          { rows: [{ authorized: true }] },
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
    const tx = createTx({
      selects: [
        [
          {
            groupId: 99,
            groupDomain: 'local',
            namespaceId: 0,
            dissolvedAt: null,
          },
        ],
        [
          {
            groupId: 99,
            groupDomain: 'local',
            namespaceId: 0,
            dissolvedAt: null,
          },
        ],
      ],
      executeResults: [
        {
          rows: [
            {
              userId: 1,
              account: 'owner',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.OWNER,
              profileRev: 1,
              available: true,
            },
          ],
        },
        {
          rows: [
            {
              userId: 2,
              account: 'member',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.MEMBER,
              profileRev: 2,
              available: true,
            },
          ],
        },
        { rows: [{ authorized: true }] },
        { rows: [{ authorized: true }] },
        {
          rows: [
            {
              userId: 1,
              account: 'owner',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.OWNER,
              profileRev: 1,
              available: true,
            },
          ],
        },
        { rows: [] },
      ],
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
    const service = createService(tx, {}, messages);

    await expect(
      service.kickMember({ threadId: 10, operatorUserId: 1, targetUserId: 2 }),
    ).resolves.toEqual({ transitioned: true });
    expect(messages.writeSystemMessageInTx).toHaveBeenCalledWith(
      tx,
      10,
      { type: 'GROUP_LEFT', member: 2 },
      {
        threadLock: { threadId: 10 },
      },
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
            groupId: 99,
            groupDomain: 'local',
            namespaceId: 0,
            dissolvedAt: null,
          },
        ],
      ],
      executeResults: [
        {
          rows: [
            {
              userId: 1,
              account: 'owner',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.OWNER,
              profileRev: 1,
              available: true,
            },
          ],
        },
        {
          rows: [
            {
              userId: 2,
              account: 'member',
              domain: 'local',
              namespaceId: 0,
              role: GroupRole.MEMBER,
              profileRev: 2,
              available: true,
            },
          ],
        },
        { rows: [{ authorized: true }] },
        { rows: [{ authorized: true }] },
        { rows: [{ userId: 1 }, { userId: 2 }] },
      ],
    });
    const rollback = new Error('group relationship write failed');
    const writeGroupRelationshipIntentInTx = vi
      .fn()
      .mockRejectedValue(rollback);
    const messages = {
      writeSystemMessageInTx: vi.fn().mockResolvedValue({
        message: { threadId: 10, seq: 9, creator: null, createdAt: new Date() },
      }),
    };
    const service = createService(
      tx,
      { writeGroupRelationshipIntentInTx },
      messages,
    );

    await expect(
      service.kickMember({ threadId: 10, operatorUserId: 1, targetUserId: 2 }),
    ).rejects.toBe(rollback);
  });
});
