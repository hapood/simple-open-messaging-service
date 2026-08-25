import {
  applyFederatedPendingProfileSnapshot,
  InviteService,
} from './invite.service.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('applyFederatedPendingProfileSnapshot', () => {
  const profile = {
    name: '!remote-group',
    avatar: 'stored-avatar',
  };

  it('applies the same pending-card snapshot fields for users and groups', () => {
    expect(
      applyFederatedPendingProfileSnapshot(profile, {
        displayName: 'Remote Group',
        avatar: 'snapshot-avatar',
      }),
    ).toEqual({
      name: 'Remote Group',
      avatar: 'snapshot-avatar',
    });
  });

  it('retains identity-backed presentation only when no snapshot is supplied', () => {
    expect(applyFederatedPendingProfileSnapshot(profile)).toEqual(profile);
  });
});

describe('InviteService.friendRelationshipStatuses', () => {
  process.env.SOMS_DOMAIN = 'local.test';
  const findMany = vi.fn();
  const getActiveP2PPeerUserIds = vi.fn();
  const database = {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => findMany()) })),
      })),
    },
  };
  const service = new InviteService(
    database as never,
    { getActiveP2PPeerUserIds } as never,
    {} as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an authoritative state for every unique requested peer', async () => {
    getActiveP2PPeerUserIds.mockResolvedValue([2]);
    findMany.mockResolvedValue([
      { id: 31n, fromUserId: 1, toUserId: 3 },
      { id: 41n, fromUserId: 4, toUserId: 1 },
      // A stale pending row cannot override an active friendship.
      { id: 21n, fromUserId: 1, toUserId: 2 },
    ]);

    await expect(
      service.friendRelationshipStatuses(1, [2, 3, 4, 5, 5, 1]),
    ).resolves.toEqual([
      { userId: 2, status: 'FRIEND' },
      { userId: 3, status: 'OUTGOING_PENDING', inviteId: '31' },
      { userId: 4, status: 'INCOMING_PENDING', inviteId: '41' },
      { userId: 5, status: 'NONE' },
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('does not query for an empty/self-only target set', async () => {
    await expect(
      service.friendRelationshipStatuses(1, [1, 1]),
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(getActiveP2PPeerUserIds).not.toHaveBeenCalled();
  });
});

describe('InviteService local friend client-state projection', () => {
  it('projects both local and peer acknowledgements with the promoted local thread id', async () => {
    const alice = {
      id: 1,
      account: 'alice',
      domain: 'local',
      isForeigner: false,
      isDeleted: false,
      name: 'Alice',
      avatar: '',
      bio: '',
    };
    const bob = {
      id: 2,
      account: 'bob',
      domain: 'local',
      isForeigner: false,
      isDeleted: false,
      name: 'Bob',
      avatar: '',
      bio: '',
    };
    const directions = [
      {
        id: 11n,
        authorUserId: 1,
        subjectUserId: 2,
        status: 'ACCEPTED',
        note: '',
        requestedAt: new Date(1),
        expiresAt: null,
      },
      {
        id: 12n,
        authorUserId: 2,
        subjectUserId: 1,
        status: 'ACCEPTED',
        note: '',
        requestedAt: new Date(1),
        expiresAt: null,
      },
    ];
    const writeInTx = vi
      .fn()
      .mockImplementation(async () => writeInTx.mock.calls.length);
    const service = new InviteService(
      {} as never,
      {} as never,
      { writeInTx } as never,
    );
    const tx = {
      query: {
        user: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce(alice)
            .mockResolvedValueOnce(bob),
        },
        relationshipIntent: {
          findMany: vi.fn().mockResolvedValue(directions),
        },
        relationshipPair: {
          findFirst: vi.fn().mockResolvedValue({ threadId: 7 }),
        },
      },
    };

    await service.writeFriendRequestClientStateInTx(tx as never, 1, 2);

    expect(writeInTx).toHaveBeenCalledTimes(4);
    const ownerOne = writeInTx.mock.calls
      .map((call) => call[1])
      .filter((write) => write.userId === 1);
    expect(ownerOne).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: 'alice',
          domain: 'local',
          subjectAccount: 'bob',
          subjectDomain: 'local',
          body: expect.objectContaining({
            direction: 'OUTGOING',
            status: 'ACCEPTED',
            localThreadId: 7,
          }),
        }),
        expect.objectContaining({
          account: 'bob',
          domain: 'local',
          subjectAccount: 'alice',
          subjectDomain: 'local',
          body: expect.objectContaining({
            direction: 'INCOMING',
            status: 'ACCEPTED',
            localThreadId: 7,
          }),
        }),
      ]),
    );
    expect(
      new Set(
        ownerOne.map(
          (write) =>
            `${write.domain}\0${write.account}\0${write.subjectDomain}\0${write.subjectAccount}`,
        ),
      ).size,
    ).toBe(2);
    expect(ownerOne.every((write) => write.body.localThreadId === 7)).toBe(
      true,
    );
    expect(ownerOne.every((write) => write.body.peer.domain === 'local')).toBe(
      true,
    );
  });

  it('allows a peer request projection to remain threadless before acceptance', async () => {
    const local = {
      id: 1,
      account: 'alice',
      domain: 'local',
      isForeigner: false,
      isDeleted: false,
      name: 'Alice',
      avatar: '',
      bio: '',
    };
    const peer = {
      id: 2,
      account: 'bob',
      domain: 'peer.test',
      isForeigner: true,
      isDeleted: false,
      name: 'Bob',
      avatar: '',
      bio: '',
    };
    const writeInTx = vi.fn().mockResolvedValue(1);
    const service = new InviteService(
      {} as never,
      {} as never,
      { writeInTx } as never,
    );
    const tx = {
      query: {
        user: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce(local)
            .mockResolvedValueOnce(peer),
        },
        relationshipIntent: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 12n,
              authorUserId: 2,
              subjectUserId: 1,
              status: 'REQUESTED',
              note: '',
              requestedAt: new Date(1),
              expiresAt: new Date(Date.now() + 60_000),
            },
          ]),
        },
        relationshipPair: {
          findFirst: vi.fn().mockResolvedValue({ threadId: null }),
        },
      },
    };

    await service.writeFriendRequestClientStateInTx(tx as never, 1, 2);

    expect(writeInTx).toHaveBeenCalledOnce();
    expect(writeInTx.mock.calls[0][1].body).toMatchObject({
      direction: 'INCOMING',
      status: 'REQUESTED',
      localThreadId: null,
    });
  });
});
