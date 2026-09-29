import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemMessageType } from '../../shared/system-message-content.js';
import { GroupRole } from '../database/enums.js';
import { groupAccount as group, profileTable } from '../database/schema.js';
import { GroupService } from './group.service.js';

const fanout = vi.hoisted(() => ({ enqueueCurrent: vi.fn() }));
vi.mock('../message/thread-fanout-task.js', () => ({
  enqueueCurrentThreadFanoutsInTx: fanout.enqueueCurrent,
}));
vi.mock('../common/locks/account-business-lock.js', () => ({
  lockBusinessAccountsInTx: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  fanout.enqueueCurrent.mockReset().mockResolvedValue(undefined);
});

vi.mock('../user/account-address.js', () => ({
  accountAddressInTx: async (_tx: unknown, target: number | object) =>
    typeof target === 'number'
      ? { account: `u${target}`, domain: 'local', namespaceId: 0 }
      : target,
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
  groupMetaOverrides: object = {},
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
    pushStateFeedDomains: vi.fn().mockResolvedValue(undefined),
    ...federationOverrides,
  };
  const clientStateFeed = {
    notifyFeedUpdated: vi.fn(),
    notifyFeedUpdates: vi.fn(),
  };
  const groupMeta = {
    reconcileProfileInTx: vi.fn().mockResolvedValue(undefined),
    ...groupMetaOverrides,
  };
  const service = new GroupService(
    database as never,
    federation as never,
    federation as never,
    clientStateFeed as never,
    groupMeta as never,
    messages as never,
  );
  return service;
}

describe('GroupService membership lifecycle', () => {
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
      selects: [
        [{ account: current.account, domain: current.domain }],
        [{ group: current }],
        [{ groupId: 99 }],
        [updated],
      ],
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
    const reconcileProfileInTx = vi.fn().mockResolvedValue(undefined);
    const service = createService(tx, {}, undefined, {
      reconcileProfileInTx,
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
          publisherNamespaceId: 0,
          profileNamespaceId: 0,
          profileRev: 4,
          displayName: 'New name',
          avatar: 'old-avatar',
          bio: 'New bio',
        },
      },
    ]);
    expect(reconcileProfileInTx).toHaveBeenCalledWith(tx, 99, 4);
    expect(fanout.enqueueCurrent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ threadId: 10 }),
    );
    expect(reconcileProfileInTx.mock.invocationCallOrder[0]).toBeLessThan(
      fanout.enqueueCurrent.mock.invocationCallOrder[0],
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
      selects: [
        [{ account: current.account, domain: current.domain }],
        [{ group: current }],
        [{ groupId: 99 }],
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
              profileRev: 2,
              available: true,
            },
          ],
        },
        { rows: [{ authorized: true }] },
      ],
    });
    const reconcileProfileInTx = vi.fn().mockResolvedValue(undefined);
    const service = createService(tx, {}, undefined, {
      reconcileProfileInTx,
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
    expect(reconcileProfileInTx).not.toHaveBeenCalled();
    expect(fanout.enqueueCurrent).not.toHaveBeenCalled();
  });

  it('commits the terminal group marker with its single dissolve message', async () => {
    const tx = createTx({
      selects: [
        [{ account: '!group', domain: 'local' }],
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
    const messages = {
      writeSystemMessageInTx: vi
        .fn()
        .mockResolvedValue({ message: { seq: 7 }, messageId: 7n }),
    };
    const service = createService(tx, {}, messages);

    await expect(
      service.markGroupDissolved({ threadId: 10, operatorUserId: 1 }),
    ).resolves.toEqual({ transitioned: true });
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledWith(group);
    expect(tx.sets[0]).toMatchObject({
      table: group,
      value: { dissolvedAt: expect.any(Date), updatedAt: expect.any(Date) },
    });
    expect(messages.writeSystemMessageInTx).toHaveBeenCalledTimes(1);
    expect(messages.writeSystemMessageInTx).toHaveBeenCalledWith(
      tx,
      10,
      { type: SystemMessageType.GROUP_DISSOLVED },
      { threadLock: { threadId: 10 } },
    );
  });

  it('treats an already committed terminal marker as idempotent', async () => {
    const tx = createTx({
      selects: [
        [{ account: '!group', domain: 'local' }],
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
    const messages = {
      writeSystemMessageInTx: vi.fn(),
    };
    const service = createService(tx, {}, messages);

    await expect(
      service.markGroupDissolved({ threadId: 10, operatorUserId: 1 }),
    ).resolves.toEqual({ transitioned: false });
    expect(tx.update).not.toHaveBeenCalled();
    expect(messages.writeSystemMessageInTx).not.toHaveBeenCalled();
  });
});
