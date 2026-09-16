import { describe, expect, it, vi } from 'vitest';
import { GroupRole } from '../../../database/enums.js';
import {
  readCurrentGroupMemberInTx,
  readCurrentGroupMemberByAddressInTx,
  readCurrentLocalAuthorizedGroupMemberIdsInTx,
  readCurrentLocalGroupManagersInTx,
  readCurrentGroupOwnersInTx,
  readCurrentGroupRosterInTx,
} from './current-group-roster.js';

describe('readCurrentGroupRosterInTx', () => {
  it('returns validated latest Group Meta members', async () => {
    const rows = [
      {
        userId: 3,
        account: 'alice',
        domain: 'local',
        namespaceId: 0,
        role: GroupRole.OWNER,
        profileRev: 1,
        available: true,
      },
    ];
    const execute = vi.fn().mockResolvedValue({ rows });

    await expect(
      readCurrentGroupRosterInTx({ execute } as never, 8),
    ).resolves.toEqual(rows);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects malformed stored member facts', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          userId: 3,
          account: 'alice',
          domain: 'local',
          namespaceId: 0,
          role: GroupRole.MEMBER,
          profileRev: -1,
          available: true,
        },
      ],
    });

    await expect(
      readCurrentGroupRosterInTx({ execute } as never, 8),
    ).rejects.toThrow('invalid current Group Meta member');
  });
});

describe('readCurrentGroupMemberInTx', () => {
  it('returns one validated current member without expanding the roster', async () => {
    const row = {
      userId: 3,
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      role: GroupRole.MEMBER,
      profileRev: 2,
      available: true,
    };
    const execute = vi.fn().mockResolvedValue({ rows: [row] });

    await expect(
      readCurrentGroupMemberInTx({ execute } as never, 8, {
        account: 'alice',
        domain: 'local',
        namespaceId: 0,
      }),
    ).resolves.toBe(row);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('returns undefined for an absent or departed member', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });

    await expect(
      readCurrentGroupMemberInTx({ execute } as never, 8, {
        account: 'alice',
        domain: 'local',
        namespaceId: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('readCurrentGroupMemberByAddressInTx', () => {
  it('resolves a current member without relying on namespace-global user lookup', async () => {
    const row = {
      userId: 4,
      account: 'member',
      domain: 'peer.example',
      namespaceId: 7,
      role: GroupRole.MEMBER,
      profileRev: 2,
      available: true,
    };
    const execute = vi.fn().mockResolvedValue({ rows: [row] });

    await expect(
      readCurrentGroupMemberByAddressInTx({ execute } as never, 8, {
        account: 'member',
        domain: 'peer.example',
      }),
    ).resolves.toBe(row);
  });
});

describe('readCurrentLocalGroupManagersInTx', () => {
  it('reads the bounded local manager projection from canonical facts', async () => {
    const rows = [{ userId: 3 }, { userId: 7 }];
    const execute = vi.fn().mockResolvedValue({ rows });

    await expect(
      readCurrentLocalGroupManagersInTx({ execute } as never, {
        groupId: 8,
        threadId: 9,
      }),
    ).resolves.toEqual(rows);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('validates an optional point-manager filter', async () => {
    await expect(
      readCurrentLocalGroupManagersInTx({} as never, {
        groupId: 8,
        threadId: 9,
        managerUserId: 0,
      }),
    ).rejects.toThrow('invalid manager user ID');
  });
});

describe('readCurrentLocalAuthorizedGroupMemberIdsInTx', () => {
  it('returns only IDs selected by the canonical active-pair query', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ userId: 3 }, { userId: 7 }],
    });

    await expect(
      readCurrentLocalAuthorizedGroupMemberIdsInTx({ execute } as never, {
        groupId: 8,
        threadId: 9,
      }),
    ).resolves.toEqual([3, 7]);
  });
});

describe('readCurrentGroupOwnersInTx', () => {
  it('returns one canonical owner per requested group', async () => {
    const rows = [
      { groupId: 8, account: 'alice', domain: 'local', namespaceId: 0 },
      { groupId: 9, account: 'bob', domain: 'peer.test', namespaceId: 1 },
    ];
    const execute = vi.fn().mockResolvedValue({ rows });

    await expect(
      readCurrentGroupOwnersInTx({ execute } as never, [8, 9, 8]),
    ).resolves.toEqual(
      rows.map(({ groupId, ...identity }) => ({ groupId, identity })),
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects multiple current owners for one group', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        { groupId: 8, account: 'alice', domain: 'local', namespaceId: 0 },
        { groupId: 8, userId: 7 },
      ],
    });

    await expect(
      readCurrentGroupOwnersInTx({ execute } as never, [8]),
    ).rejects.toThrow('invalid current Group Meta owner set');
  });

  it('does not query for an empty group set', async () => {
    const execute = vi.fn();

    await expect(
      readCurrentGroupOwnersInTx({ execute } as never, []),
    ).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
