vi.mock('../user/account-address.js', async (original) => ({
  ...(await original<typeof import('../user/account-address.js')>()),
  localAccountsForTargetsInTx: async (
    _tx: unknown,
    targets: { account: string }[],
  ) =>
    targets.map((target) => ({ id: target.account === 'old-owner' ? 1 : 2 })),
}));
import { describe, expect, it, vi } from 'vitest';
import { GroupRole } from '../database/enums.js';
import {
  messageThread as group,
  accountThreadState,
} from '../database/schema.js';
import { AuthoritativeGroupMetaMutationService } from './authoritative-group-meta-mutation.service.js';

function createHarness() {
  const writes: Array<{ table: unknown; value: unknown }> = [];
  const update = vi.fn((table: unknown) => {
    const query = {
      set: vi.fn((value: unknown) => {
        writes.push({ table, value });
        return query;
      }),
      where: vi.fn().mockResolvedValue(undefined),
    };
    return query;
  });
  const tx = { update };
  const reconcileMembersInTx = vi.fn().mockResolvedValue(8n);
  const reconcileProfileInTx = vi.fn().mockResolvedValue(9n);
  const enqueueGroupMetaHeadFanoutInTx = vi
    .fn()
    .mockResolvedValue({ taskId: 9n });
  const service = new AuthoritativeGroupMetaMutationService(
    { reconcileMembersInTx, reconcileProfileInTx } as never,
    { enqueueGroupMetaHeadFanoutInTx } as never,
  );
  return {
    service,
    tx,
    writes,
    reconcileMembersInTx,
    reconcileProfileInTx,
    enqueueGroupMetaHeadFanoutInTx,
  };
}

describe('AuthoritativeGroupMetaMutationService', () => {
  it('writes a canonical group profile fact', async () => {
    const target = createHarness();

    await target.service.applyProfileFactInTx(target.tx as never, 5, 4);

    expect(target.reconcileProfileInTx).toHaveBeenCalledWith(target.tx, 5, 4);
  });

  it('atomically transfers ownership while preserving both profile revisions', async () => {
    const target = createHarness();
    await target.service.applyRoleFactsInTx(target.tx as never, {
      threadId: 12,
      groupId: 5,
      changes: [
        {
          member: {
            userId: 1,
            account: 'old-owner',
            domain: 'local',
            namespaceId: 0,
            role: GroupRole.OWNER,
            profileRev: 4,
            available: true,
          },
          role: GroupRole.MEMBER,
        },
        {
          member: {
            userId: 2,
            account: 'new-owner',
            domain: 'local',
            namespaceId: 0,
            role: GroupRole.MEMBER,
            profileRev: 7,
            available: true,
          },
          role: GroupRole.OWNER,
        },
      ],
    });
    await target.service.finalizeInTx(target.tx as never, {
      threadId: 12,
      groupAccount: '!group',
    });

    expect(target.reconcileMembersInTx).toHaveBeenCalledWith(target.tx, 5, [
      {
        namespaceId: 0,
        account: 'old-owner',
        domain: 'local',
        operation: 'UPSERT',
        body: { role: GroupRole.MEMBER, profileRev: 4 },
      },
      {
        namespaceId: 0,
        account: 'new-owner',
        domain: 'local',
        operation: 'UPSERT',
        body: { role: GroupRole.OWNER, profileRev: 7 },
      },
    ]);
    expect(target.writes.map((write) => write.table)).toEqual([
      accountThreadState,
      accountThreadState,
      group,
    ]);
    expect(target.enqueueGroupMetaHeadFanoutInTx).toHaveBeenCalledWith(
      target.tx,
      {
        group: { account: '!group', domain: 'local' },
        threadId: 12,
      },
    );
    expect(
      target.reconcileMembersInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(
      target.enqueueGroupMetaHeadFanoutInTx.mock.invocationCallOrder[0],
    );
  });

  it('does not create a local participant projection for a remote member demotion', async () => {
    const target = createHarness();
    await target.service.applyRoleFactsInTx(target.tx as never, {
      threadId: 12,
      groupId: 5,
      changes: [
        {
          member: {
            userId: 3,
            account: 'remote',
            domain: 'peer.example',
            namespaceId: 6,
            role: GroupRole.ADMIN,
            profileRev: 2,
            available: true,
          },
          role: GroupRole.MEMBER,
        },
      ],
    });
    await target.service.finalizeInTx(target.tx as never, {
      threadId: 12,
      groupAccount: '!group',
    });

    expect(target.writes.map((write) => write.table)).toEqual([group]);
  });
});
