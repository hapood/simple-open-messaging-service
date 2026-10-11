import { describe, expect, it, vi } from 'vitest';
import { SystemMessageType } from '../../../shared/system-message-content.js';
import { GroupRole } from '../../database/enums.js';
import { BusinessCode } from '../../common/business-code.js';
import {
  GroupRosterRoleService,
  type GroupRosterRoleCommand,
} from './group-roster-role.service.js';

vi.mock('../../common/locks/account-business-lock.js', () => ({
  lockBusinessAccountsInTx: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../common/locks/thread-content-lock.js', () => ({
  requireGroupThreadContentLockUnderGroupInTx: vi.fn(
    async (tx: unknown, _groupId: number, threadId: number) => ({
      tx,
      threadId,
    }),
  ),
}));

vi.mock(
  '../membership-intent/shared/group-membership-projection-fanout.js',
  () => ({
    admitGroupMembershipProjectionFanoutInTx: vi
      .fn()
      .mockResolvedValue(undefined),
  }),
);

vi.mock('../../message/thread-fanout-task.js', () => ({
  enqueueCurrentThreadFanoutsInTx: vi.fn().mockResolvedValue(undefined),
}));

const owner = {
  account: 'owner',
  domain: 'local',
  namespaceId: 0,
  role: GroupRole.OWNER,
  operatorProfileRev: 3,
  operatorAuthorized: true,
};

/** Authorization row for an owner acting on a local MEMBER target. */
function authorizedRow(overrides: object = {}) {
  return {
    groupAccount: '!group',
    groupDomain: 'local',
    namespaceId: 0,
    dissolvedAt: null,
    operatorAccount: owner.account,
    operatorDomain: owner.domain,
    operatorRole: owner.role,
    operatorProfileRev: owner.operatorProfileRev,
    operatorAuthorized: owner.operatorAuthorized,
    targetAccount: 'member',
    targetDomain: 'local',
    targetNamespaceId: 0,
    targetRole: GroupRole.MEMBER,
    targetProfileRev: 6,
    targetActive: true,
    localTargetId: 2,
    ...overrides,
  };
}

function createTx(executeRows: Array<{ rows: unknown[] }>) {
  const executeResults = [...executeRows];
  const execute = vi.fn(() =>
    Promise.resolve(executeResults.shift() ?? { rows: [{ ok: true }] }),
  );
  const sets: Array<{ table: unknown; value: unknown }> = [];
  const update = vi.fn((table: unknown) => {
    const query = {
      set: vi.fn((value: unknown) => {
        sets.push({ table, value });
        return query;
      }),
      where: vi.fn(() => query),
      returning: vi.fn(() => Promise.resolve([])),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve),
    };
    return query;
  });
  const tx = { execute, update, sets };
  return Object.assign(tx, {
    db: {
      transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
    },
  });
}

function createService(tx: ReturnType<typeof createTx>, overrides = {}) {
  const groupMeta = {
    reconcileMembersInTx: vi.fn().mockResolvedValue(9n),
  };
  const messages = {
    writeSystemMessageInTx: vi
      .fn()
      .mockResolvedValue({ message: { seq: 4 }, messageId: 1n }),
  };
  const service = new GroupRosterRoleService({
    database: tx as never,
    groupMeta,
    messages,
    ...overrides,
  });
  return { service, groupMeta, messages };
}

describe('GroupRosterRoleService', () => {
  it('transfers ownership: keeps the previous owner as admin, then emits the event and fan-outs', async () => {
    const tx = createTx([
      { rows: [{ groupAccount: '!group', groupDomain: 'local' }] },
      { rows: [{ ok: true }] },
      { rows: [] },
      { rows: [authorizedRow()] },
    ]);
    const { service, groupMeta, messages } = createService(tx);

    const outcome = await service.execute({
      threadId: 10,
      operatorUserId: 1,
      kind: 'TRANSFER_OWNERSHIP',
      target: { account: 'member', namespaceId: 0 },
    });

    expect(outcome).toEqual({ status: 'APPLIED' });
    expect(groupMeta.reconcileMembersInTx).toHaveBeenCalledWith(
      tx,
      10,
      expect.arrayContaining([
        expect.objectContaining({
          account: 'owner',
          operation: 'MEMBER_UPSERT',
          body: {
            role: GroupRole.ADMIN,
            profileNamespaceId: 0,
            profileRev: 3,
          },
        }),
        expect.objectContaining({
          account: 'member',
          operation: 'MEMBER_UPSERT',
          body: {
            role: GroupRole.OWNER,
            profileNamespaceId: 0,
            profileRev: 6,
          },
        }),
      ]),
    );
    expect(messages.writeSystemMessageInTx).toHaveBeenCalledWith(
      tx,
      10,
      {
        type: SystemMessageType.GROUP_OWNER_TRANSFERRED,
        previousOwner: {
          account: 'owner',
          profileNamespaceId: 0,
          profileRev: 0,
        },
        newOwner: {
          account: 'member',
          profileNamespaceId: 0,
          profileRev: 0,
        },
      },
      { threadLock: { tx, threadId: 10 } },
    );
    // The previous owner keeps manager capability as ADMIN; the ordinary
    // target receives a freshly initialized manager projection as OWNER.
    expect(tx.sets).toEqual([
      {
        table: expect.anything(),
        value: {
          role: GroupRole.ADMIN,
          updatedAt: expect.any(Date),
        },
      },
      {
        table: expect.anything(),
        value: expect.objectContaining({
          role: GroupRole.OWNER,
          updatedAt: expect.any(Date),
        }),
      },
    ]);
    const newOwnerProjection = tx.sets[1]!.value as Record<string, unknown>;
    expect(newOwnerProjection).toHaveProperty('joinRequestEndFeedId');
    expect(newOwnerProjection).toHaveProperty('joinRequestReadFeedId');
    expect(newOwnerProjection).toHaveProperty('groupInviteEndFeedId');
    // Facts first, then the system event, then the manager-set fan-out.
    const { admitGroupMembershipProjectionFanoutInTx } = await import(
      '../membership-intent/shared/group-membership-projection-fanout.js'
    );
    expect(
      groupMeta.reconcileMembersInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(messages.writeSystemMessageInTx.mock.invocationCallOrder[0]);
    expect(
      messages.writeSystemMessageInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(
      (admitGroupMembershipProjectionFanoutInTx as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder[0],
    );
  });

  it('preserves manager watermarks when an administrator becomes owner', async () => {
    const tx = createTx([
      { rows: [{ groupAccount: '!group', groupDomain: 'local' }] },
      { rows: [{ ok: true }] },
      { rows: [] },
      { rows: [authorizedRow({ targetRole: GroupRole.ADMIN })] },
    ]);
    const { service } = createService(tx);

    const outcome = await service.execute({
      threadId: 10,
      operatorUserId: 1,
      kind: 'TRANSFER_OWNERSHIP',
      target: { account: 'member', namespaceId: 0 },
    });

    expect(outcome).toEqual({ status: 'APPLIED' });
    const targetProjection = tx.sets[1]!.value as Record<string, unknown>;
    expect(targetProjection).toEqual({
      role: GroupRole.OWNER,
      updatedAt: expect.any(Date),
    });
    expect(targetProjection).not.toHaveProperty('joinRequestEndFeedId');
    expect(targetProjection).not.toHaveProperty('joinRequestReadFeedId');
    expect(targetProjection).not.toHaveProperty('groupInviteEndFeedId');
  });

  it('grants ADMIN with a single role fact and the granted event', async () => {
    const tx = createTx([
      { rows: [{ groupAccount: '!group', groupDomain: 'local' }] },
      { rows: [{ ok: true }] },
      { rows: [] },
      { rows: [authorizedRow()] },
    ]);
    const { service, groupMeta, messages } = createService(tx);

    const outcome = await service.execute({
      threadId: 10,
      operatorUserId: 1,
      kind: 'SET_ROLE',
      target: { account: 'member', namespaceId: 0 },
      role: GroupRole.ADMIN,
    });

    expect(outcome).toEqual({ status: 'APPLIED' });
    expect(groupMeta.reconcileMembersInTx).toHaveBeenCalledWith(tx, 10, [
      expect.objectContaining({
        account: 'member',
        body: {
          role: GroupRole.ADMIN,
          profileNamespaceId: 0,
          profileRev: 6,
        },
      }),
    ]);
    expect(messages.writeSystemMessageInTx).toHaveBeenCalledWith(
      tx,
      10,
      expect.objectContaining({ type: SystemMessageType.GROUP_ADMIN_GRANTED }),
      expect.anything(),
    );
  });

  it('reports a same-role change as a no-op without writing', async () => {
    const tx = createTx([
      { rows: [{ groupAccount: '!group', groupDomain: 'local' }] },
      { rows: [{ ok: true }] },
      { rows: [] },
      { rows: [authorizedRow({ targetRole: GroupRole.ADMIN })] },
    ]);
    const { service, groupMeta, messages } = createService(tx);

    const outcome = await service.execute({
      threadId: 10,
      operatorUserId: 1,
      kind: 'SET_ROLE',
      target: { account: 'member', namespaceId: 0 },
      role: GroupRole.ADMIN,
    });

    expect(outcome).toEqual({ status: 'NO_OP', reason: 'ROLE_UNCHANGED' });
    expect(groupMeta.reconcileMembersInTx).not.toHaveBeenCalled();
    expect(messages.writeSystemMessageInTx).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('rejects a dissolved group as data and writes nothing', async () => {
    const tx = createTx([
      { rows: [{ groupAccount: '!group', groupDomain: 'local' }] },
      { rows: [{ ok: true }] },
      { rows: [] },
      { rows: [authorizedRow({ dissolvedAt: '2026-09-13T00:00:00Z' })] },
    ]);
    const { service, groupMeta } = createService(tx);

    const outcome = await service.execute({
      threadId: 10,
      operatorUserId: 1,
      kind: 'TRANSFER_OWNERSHIP',
      target: { account: 'member', namespaceId: 0 },
    });

    expect(outcome).toEqual({
      status: 'REJECTED',
      reason: 'GROUP_DISSOLVED',
      code: BusinessCode.GROUP_DISSOLVED,
      message: 'group has been dissolved',
    });
    expect(groupMeta.reconcileMembersInTx).not.toHaveBeenCalled();
  });

  it('rejects a non-owner operator before reading the target', async () => {
    const tx = createTx([
      { rows: [{ groupAccount: '!group', groupDomain: 'local' }] },
      { rows: [{ ok: true }] },
      { rows: [] },
      {
        rows: [
          authorizedRow({
            operatorRole: GroupRole.ADMIN,
            operatorAuthorized: true,
          }),
        ],
      },
    ]);
    const { service, groupMeta } = createService(tx);

    const outcome = await service.execute({
      threadId: 10,
      operatorUserId: 1,
      kind: 'SET_ROLE',
      target: { account: 'member', namespaceId: 0 },
      role: GroupRole.MEMBER,
    });

    expect(outcome).toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.GROUP_FORBIDDEN,
    });
    expect(groupMeta.reconcileMembersInTx).not.toHaveBeenCalled();
  });

  it('keeps ownership transfers on the origin', async () => {
    const tx = createTx([
      { rows: [{ groupAccount: '!group', groupDomain: 'local' }] },
      {
        rows: [
          authorizedRow({
            targetAccount: 'visitor',
            targetDomain: 'peer.example',
            targetNamespaceId: 4,
            targetRole: GroupRole.MEMBER,
            targetActive: true,
            localTargetId: null,
          }),
        ],
      },
    ]);
    const { service } = createService(tx);

    const outcome = await service.execute({
      threadId: 10,
      operatorUserId: 1,
      kind: 'TRANSFER_OWNERSHIP',
      target: { account: 'visitor', namespaceId: 9 },
    });

    expect(outcome).toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.GROUP_FORBIDDEN,
    });
  });

  it('refuses ADMIN grants to a peer-hosted member', async () => {
    const tx = createTx([
      { rows: [{ groupAccount: '!group', groupDomain: 'local' }] },
      {
        rows: [
          authorizedRow({
            targetAccount: 'visitor',
            targetDomain: 'peer.example',
            targetNamespaceId: 4,
            targetActive: true,
            localTargetId: null,
          }),
        ],
      },
    ]);
    const { service } = createService(tx);

    const outcome = await service.execute({
      threadId: 10,
      operatorUserId: 1,
      kind: 'SET_ROLE',
      target: { account: 'visitor', namespaceId: 9 },
      role: GroupRole.ADMIN,
    });

    expect(outcome).toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.GROUP_FORBIDDEN,
    });
  });

  it('rejects a target that is not an active roster member', async () => {
    const tx = createTx([
      { rows: [{ groupAccount: '!group', groupDomain: 'local' }] },
      { rows: [{ ok: true }] },
      { rows: [] },
      { rows: [authorizedRow({ targetAccount: null, targetActive: false })] },
    ]);
    const { service } = createService(tx);

    const outcome = await service.execute({
      threadId: 10,
      operatorUserId: 1,
      kind: 'TRANSFER_OWNERSHIP',
      target: { account: 'stranger', namespaceId: 0 },
    });

    expect(outcome).toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.GROUP_TARGET_NOT_MEMBER,
    });
  });

  it('routes ownership changes away from SET_ROLE before any database work', async () => {
    const tx = createTx([]);
    const { service } = createService(tx);

    const outcome = await service.execute({
      threadId: 10,
      operatorUserId: 1,
      kind: 'SET_ROLE',
      target: { account: 'member', namespaceId: 0 },
      role: GroupRole.OWNER,
    } as GroupRosterRoleCommand);

    expect(outcome).toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.GROUP_FORBIDDEN,
    });
    expect(tx.execute).not.toHaveBeenCalled();
  });
});
