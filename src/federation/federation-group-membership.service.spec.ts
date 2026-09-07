import { describe, expect, it, vi } from 'vitest';
import { GroupRole } from '../database/enums.js';
import { accountThreadState, account } from '../database/schema.js';
import { FederationGroupMembershipService } from './federation-group-membership.service.js';

function queryResult<T>(value: T) {
  const query: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy'])
    query[method] = vi.fn(() => query);
  query.then = (
    resolve: (result: T) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return query;
}

function harness(params?: {
  current?: Record<string, unknown>;
  localAccount?: boolean;
}) {
  const identity = {
    id: 11,
    account: 'alice',
    domain: 'local',
  };
  const participantConflict = vi.fn().mockResolvedValue(undefined);
  const participantValues = vi.fn(() => ({
    onConflictDoUpdate: participantConflict,
  }));
  const insert = vi.fn((table) => {
    expect(table).toBe(accountThreadState);
    return { values: participantValues };
  });
  const execute = vi.fn().mockResolvedValue({
    rows: params?.current ? [params.current] : [],
  });
  const tx = {
    query: { account: { findFirst: vi.fn().mockResolvedValue(identity) } },
    execute,
    insert,
    select: vi.fn(() => ({
      from: (table: unknown) =>
        queryResult(table === account ? [identity] : [{ profileRev: 1 }]),
    })),
  };
  const reconcileMembersInTx = vi.fn().mockResolvedValue(4n);
  const reconcileProfileInTx = vi.fn().mockResolvedValue(3n);
  const service = new FederationGroupMembershipService({
    reconcileMembersInTx,
    reconcileProfileInTx,
  } as never);
  return {
    service,
    tx,
    execute,
    insert,
    participantValues,
    participantConflict,
    reconcileMembersInTx,
    reconcileProfileInTx,
  };
}

const currentMember = {
  userId: 11,
  account: 'alice',
  domain: 'local',
  namespaceId: 0,
  role: 'ADMIN',
  profileRev: 2,
  available: true,
};

describe('FederationGroupMembershipService', () => {
  it('appends the initial authoritative fact from the member intent revision', async () => {
    const target = harness();

    await expect(
      target.service.syncFromActiveInTx(target.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: 11,
        active: true,
        hostedLocally: true,
        memberProfileRev: 3,
      }),
    ).resolves.toEqual({ canonicalRosterChanged: true });

    expect(target.reconcileMembersInTx).toHaveBeenCalledWith(target.tx, 5, [
      {
        namespaceId: 0,
        account: 'alice',
        domain: 'local',
        operation: 'UPSERT',
        body: { role: 'MEMBER', profileRev: 3 },
      },
    ]);
    expect(target.reconcileProfileInTx).toHaveBeenCalledWith(target.tx, 5, 1);
    expect(
      target.reconcileProfileInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(target.reconcileMembersInTx.mock.invocationCallOrder[0]);
    expect(target.participantValues).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 11, threadId: 7, role: 'MEMBER' }),
    );
  });

  it('uses an explicit owner role only for the first canonical membership fact', async () => {
    const target = harness();

    await target.service.syncFromActiveInTx(target.tx as never, {
      threadId: 7,
      groupId: 5,
      memberUserId: 11,
      active: true,
      hostedLocally: true,
      memberProfileRev: 3,
      initialRole: GroupRole.OWNER,
    });

    expect(target.reconcileMembersInTx).toHaveBeenCalledWith(target.tx, 5, [
      expect.objectContaining({
        operation: 'UPSERT',
        body: { role: 'OWNER', profileRev: 3 },
      }),
    ]);
    expect(target.participantValues).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'OWNER' }),
    );
  });

  it('keeps the canonical role and profile revision while membership remains active', async () => {
    const target = harness({ current: currentMember });

    await expect(
      target.service.syncFromActiveInTx(target.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: 11,
        active: true,
        hostedLocally: true,
        memberProfileRev: 9,
        initialRole: GroupRole.OWNER,
      }),
    ).resolves.toEqual({ canonicalRosterChanged: false });

    expect(target.reconcileMembersInTx).not.toHaveBeenCalled();
    expect(target.reconcileProfileInTx).not.toHaveBeenCalled();
    expect(target.participantValues).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ADMIN' }),
    );
    expect(target.participantConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          role: 'ADMIN',
          messageVisibleThroughSeq: null,
        }),
      }),
    );
  });

  it('appends a bodyless departure but protects the current owner', async () => {
    const member = harness({ current: currentMember });
    await expect(
      member.service.syncFromActiveInTx(member.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: 11,
        active: false,
        hostedLocally: true,
      }),
    ).resolves.toEqual({ canonicalRosterChanged: true });
    expect(member.reconcileMembersInTx).toHaveBeenCalledWith(member.tx, 5, [
      expect.objectContaining({ operation: 'DEPART', body: {} }),
    ]);
    expect(member.insert).not.toHaveBeenCalled();

    const owner = harness({
      current: { ...currentMember, role: 'OWNER' },
    });
    await expect(
      owner.service.syncFromActiveInTx(owner.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: 11,
        active: false,
        hostedLocally: true,
      }),
    ).resolves.toEqual({ canonicalRosterChanged: false });
    expect(owner.reconcileMembersInTx).not.toHaveBeenCalled();
  });

  it('writes only local conversation state for a mirrored group', async () => {
    const target = harness();

    await expect(
      target.service.syncFromActiveInTx(target.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: 11,
        active: true,
        hostedLocally: false,
      }),
    ).resolves.toEqual({ canonicalRosterChanged: false });

    expect(target.execute).not.toHaveBeenCalled();
    expect(target.reconcileMembersInTx).not.toHaveBeenCalled();
    expect(target.participantValues).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'MEMBER' }),
    );
  });

  it('retains canonical history during dissolution fan-out', async () => {
    const target = harness();

    await expect(
      target.service.syncFromActiveInTx(target.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: 11,
        active: false,
        hostedLocally: true,
        allowOwnerDeactivation: true,
        updateCanonicalRoster: false,
      }),
    ).resolves.toEqual({ canonicalRosterChanged: false });

    expect(target.execute).not.toHaveBeenCalled();
    expect(target.reconcileMembersInTx).not.toHaveBeenCalled();
  });
});
