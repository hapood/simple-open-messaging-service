import { describe, expect, it, vi } from 'vitest';
import { SystemMessageType } from '../../../../shared/system-message-content.js';
import { GroupRole } from '../../../database/enums.js';
import { BusinessCode } from '../../../common/business-code.js';
import {
  GroupRosterRoleService,
  type GroupRosterRoleCommand,
} from './group-roster-role.service.js';

vi.mock('../../shared/locks/account-business-lock.js', () => ({
  lockBusinessAccountsInTx: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/locks/thread-content-lock.js', () => ({
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

vi.mock('../../../message/thread-fanout-task.js', () => ({
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
  it('transfers ownership: swaps two roster facts, then the system event and fan-outs', async () => {
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
      target: { account: 'member', domain: 'local' },
    });

    expect(outcome).toEqual({ status: 'APPLIED' });
    expect(groupMeta.reconcileMembersInTx).toHaveBeenCalledWith(
      tx,
      10,
      expect.arrayContaining([
        expect.objectContaining({
          account: 'owner',
          operation: 'UPSERT',
          body: { role: GroupRole.MEMBER, profileRev: 3 },
        }),
        expect.objectContaining({
          account: 'member',
          operation: 'UPSERT',
          body: { role: GroupRole.OWNER, profileRev: 6 },
        }),
      ]),
    );
    expect(messages.writeSystemMessageInTx).toHaveBeenCalledWith(
      tx,
      10,
      {
        type: SystemMessageType.GROUP_OWNER_TRANSFERRED,
        previousOwner: { account: 'owner', domain: 'local', namespaceId: 0 },
        newOwner: { account: 'member', domain: 'local', namespaceId: 0 },
      },
      { threadLock: { tx, threadId: 10 } },
    );
    // Both local projections carry the swapped roles.
    expect(tx.sets).toEqual([
      {
        table: expect.anything(),
        value: { role: GroupRole.MEMBER, updatedAt: expect.any(Date) },
      },
      {
        table: expect.anything(),
        value: { role: GroupRole.OWNER, updatedAt: expect.any(Date) },
      },
    ]);
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
      target: { account: 'member', domain: 'local' },
      role: GroupRole.ADMIN,
    });

    expect(outcome).toEqual({ status: 'APPLIED' });
    expect(groupMeta.reconcileMembersInTx).toHaveBeenCalledWith(tx, 10, [
      expect.objectContaining({
        account: 'member',
        body: { role: GroupRole.ADMIN, profileRev: 6 },
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
      target: { account: 'member', domain: 'local' },
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
      target: { account: 'member', domain: 'local' },
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
      target: { account: 'member', domain: 'local' },
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
      target: { account: 'visitor', domain: 'peer.example' },
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
      target: { account: 'visitor', domain: 'peer.example' },
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
      target: { account: 'stranger', domain: 'local' },
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
      target: { account: 'member', domain: 'local' },
      role: GroupRole.OWNER,
    } as GroupRosterRoleCommand);

    expect(outcome).toMatchObject({
      status: 'REJECTED',
      code: BusinessCode.GROUP_FORBIDDEN,
    });
    expect(tx.execute).not.toHaveBeenCalled();
  });
});
