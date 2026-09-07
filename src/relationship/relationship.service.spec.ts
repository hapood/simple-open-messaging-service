import {
  applyFederatedPendingProfileSnapshot,
  RelationshipService,
} from './relationship.service.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { messageThread, accountThreadState } from '../database/schema.js';

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

function localRecipientQuery(rows: unknown[]) {
  return () => ({
    from: () => ({ where: () => ({ orderBy: async () => rows }) }),
  });
}
describe('relationship client profile references', () => {
  function setup(peerRev?: number, available = true) {
    const local = {
      id: 1,
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      availability: 'AVAILABLE',
      name: 'New default',
      avatar: 'wrong',
      bio: 'wrong',
      defaultProfileRev: 99,
    };
    const remote = {
      ...local,
      id: 2,
      account: 'bob',
      domain: 'remote.test',
      namespaceId: 4,
      defaultProfileRev: 0,
    };
    const tx = {
      select: localRecipientQuery([local]),
      query: {
        account: {
          findFirst: vi.fn().mockResolvedValue(local),
        },
        profileTable: {
          findFirst: vi.fn().mockImplementation(async ({ where }) => {
            const params = new PgDialect().sqlToQuery(where).params;
            if (!available) return undefined;
            return {
              displayName: `Selected ${params[3]}`,
              avatar: `avatar-${params[3]}`,
              bio: 'selected',
            };
          }),
        },
      },
    };
    const intent = {
      status: 'ACCEPTED',
      requestedAt: null,
      expiresAt: null,
      note: '',
      profileRev: 3,
    };
    const writeInTx = vi.fn().mockResolvedValue(1);
    const service = new RelationshipService(
      {} as never,
      {} as never,
      { writeInTx } as never,
      {
        readP2PRelationshipInTx: vi.fn().mockResolvedValue({
          pair: { threadId: 9 },
          firstIntent: intent,
          secondIntent:
            peerRev === undefined
              ? undefined
              : { ...intent, profileRev: peerRev },
        }),
      } as never,
      {} as never,
    );
    return { service, tx, writeInTx };
  }

  it('uses the peer-authored intent revision in both directions, never either user default', async () => {
    const { service, tx, writeInTx } = setup(7);
    await service.writeRelationshipRequestClientStateInTx(tx as never, 1, {
      account: 'bob',
      domain: 'remote.test',
      namespaceId: 4,
    });
    expect(writeInTx).toHaveBeenCalledTimes(2);
    for (const [, event] of writeInTx.mock.calls) {
      expect(event.body.peer).toMatchObject({
        account: 'bob',
        profileRev: 7,
        name: 'Selected 7',
        avatar: 'avatar-7',
      });
    }
    expect(
      tx.query.profileTable.findFirst.mock.calls.map(
        ([arg]) => new PgDialect().sqlToQuery(arg.where).params,
      ),
    ).toEqual([
      ['bob', 'remote.test', 4, 7],
      ['bob', 'remote.test', 4, 7],
    ]);
  });

  it('retains the exact reference and an empty image when the version is not materialized', async () => {
    const { service, tx, writeInTx } = setup(7, false);
    await service.writeRelationshipRequestClientStateInTx(tx as never, 1, {
      account: 'bob',
      domain: 'remote.test',
      namespaceId: 4,
    });
    expect(writeInTx.mock.calls[0][1].body.peer).toMatchObject({
      profileRev: 7,
      name: 'bob',
      avatar: '',
      bio: '',
    });
  });

  it('does not invent a peer profile reference when only the local intent exists', async () => {
    const { service, tx, writeInTx } = setup();
    await service.writeRelationshipRequestClientStateInTx(tx as never, 1, {
      account: 'bob',
      domain: 'remote.test',
      namespaceId: 4,
    });
    expect(writeInTx.mock.calls[0][1].body.peer).toMatchObject({
      profileRev: 0,
      name: 'bob',
      avatar: '',
    });
  });
});

describe('RelationshipService.friendRelationshipStatuses', () => {
  process.env.SOMS_DOMAIN = 'local.test';
  const findMany = vi.fn();
  const getActiveP2PPeerUserIds = vi.fn();
  const execute = vi.fn(async () => ({ rows: await findMany() }));
  const database = {
    db: {
      execute,
    },
  };
  const service = new RelationshipService(
    database as never,
    { getActiveP2PPeerUserIds } as never,
    {} as never,
    {} as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an authoritative state for every unique requested peer', async () => {
    getActiveP2PPeerUserIds.mockResolvedValue([2]);
    findMany.mockResolvedValue([
      { id: 31n, peerUserId: 3, direction: 'OUTGOING' },
      { id: 41n, peerUserId: 4, direction: 'INCOMING' },
      // A stale pending row cannot override an active friendship.
      { id: 21n, peerUserId: 2, direction: 'OUTGOING' },
    ]);

    await expect(
      service.friendRelationshipStatuses(1, [2, 3, 4, 5, 5, 1]),
    ).resolves.toEqual([
      { userId: 2, status: 'FRIEND' },
      { userId: 3, status: 'OUTGOING_PENDING' },
      { userId: 4, status: 'INCOMING_PENDING' },
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

  it('binds a single requested peer as an IN-list scalar', async () => {
    getActiveP2PPeerUserIds.mockResolvedValue([]);
    findMany.mockResolvedValue([]);

    await service.friendRelationshipStatuses(1, [2]);

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain('peer.id IN ($2)');
    expect(query.sql).not.toContain('ANY');
    expect(query.params).toEqual([1, 2]);
  });
});

describe('RelationshipService P2P shell storage', () => {
  it('binds a federated P2P thread to its remote namespace', async () => {
    const threadValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 7 }]),
    });
    const participantValues = vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    const tx = {
      query: {
        account: { findFirst: vi.fn().mockResolvedValue({ account: 'alice' }) },
      },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ orderBy: async () => [{ id: 1 }] }),
        }),
      }),
      insert: vi.fn((table: unknown) =>
        table === messageThread
          ? { values: threadValues }
          : { values: participantValues },
      ),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    const service = new RelationshipService(
      {} as never,
      {} as never,
      {} as never,
      {
        lockPairInTx: vi.fn().mockResolvedValue({
          id: 1n,
          threadId: null,
          endpointA: {
            type: 'USER',
            account: 'alice',
            domain: 'local',
            namespaceId: 7,
          },
          endpointB: {
            type: 'USER',
            account: 'bob',
            domain: 'remote.test',
            namespaceId: 7,
          },
        }),
      } as never,
    );
    const target = service as unknown as {
      ensureP2PThreadShellInTx(
        transaction: unknown,
        firstUserId: number,
        secondUserId: number,
      ): Promise<number>;
    };

    await expect(target.ensureP2PThreadShellInTx(tx, 1, 2)).resolves.toBe(7);
    expect(threadValues).toHaveBeenCalledExactlyOnceWith({
      type: 'P2P',
      authorityNamespaceId: 7,
      updatedAt: expect.any(Date),
    });
  });

  it('binds a local-only P2P thread to namespace zero', async () => {
    const threadValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 7 }]),
    });
    const tx = {
      query: {
        account: { findFirst: vi.fn().mockResolvedValue({ account: 'alice' }) },
      },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValue({ orderBy: async () => [{ id: 1 }, { id: 2 }] }),
        }),
      }),
      insert: vi.fn((table: unknown) =>
        table === messageThread
          ? { values: threadValues }
          : {
              values: vi.fn().mockReturnValue({
                onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
              }),
            },
      ),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    const service = new RelationshipService(
      {} as never,
      {} as never,
      {} as never,
      {
        lockPairInTx: vi.fn().mockResolvedValue({
          id: 1n,
          threadId: null,
          endpointA: {
            type: 'USER',
            account: 'alice',
            domain: 'local',
            namespaceId: 0,
          },
          endpointB: {
            type: 'USER',
            account: 'bob',
            domain: 'local',
            namespaceId: 0,
          },
        }),
      } as never,
    );
    const target = service as unknown as {
      ensureP2PThreadShellInTx(
        transaction: unknown,
        firstUserId: number,
        secondUserId: number,
      ): Promise<number>;
    };

    await target.ensureP2PThreadShellInTx(tx, 1, 2);

    expect(threadValues).toHaveBeenCalledExactlyOnceWith({
      type: 'P2P',
      authorityNamespaceId: 0,
      updatedAt: expect.any(Date),
    });
  });

  it('creates client participants only for local accounts', async () => {
    const participantValues = vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    const insert = vi.fn((table: unknown) => {
      if (table !== accountThreadState) throw new Error('unexpected insert');
      return { values: participantValues };
    });
    const tx = {
      query: {
        account: { findFirst: vi.fn().mockResolvedValue({ account: 'alice' }) },
      },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ orderBy: async () => [{ id: 1 }] }),
        }),
      }),
      insert,
    };
    const service = new RelationshipService(
      {} as never,
      {} as never,
      {} as never,
      { lockPairInTx: vi.fn().mockResolvedValue({ threadId: 7 }) } as never,
    );
    const target = service as unknown as {
      ensureP2PThreadShellInTx(
        transaction: unknown,
        firstUserId: number,
        secondUserId: number,
      ): Promise<number>;
    };

    await expect(target.ensureP2PThreadShellInTx(tx, 1, 2)).resolves.toBe(7);
    expect(participantValues).toHaveBeenCalledExactlyOnceWith([
      { accountId: 1, threadId: 7 },
    ]);
  });

  it('cleans an unused shell without a separate endpoint projection table', async () => {
    const deletedTables: unknown[] = [];
    const tx = {
      query: {
        account: { findFirst: vi.fn().mockResolvedValue({ account: 'alice' }) },
      },
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ threadId: 7 }] })
        .mockResolvedValueOnce({ rows: [] }),
      delete: vi.fn((table: unknown) => {
        deletedTables.push(table);
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    };
    const service = new RelationshipService(
      {
        db: {
          transaction: vi.fn(
            async (run: (transaction: unknown) => Promise<unknown>) => run(tx),
          ),
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.cleanupExpiredRelationshipShells()).resolves.toBe(1);
    expect(deletedTables).toEqual([accountThreadState, messageThread]);
  });
});

describe('RelationshipService local relationship client-state projection', () => {
  it('projects both local and peer acknowledgements with the promoted local thread id', async () => {
    const alice = {
      id: 1,
      account: 'alice',
      domain: 'local',
      availability: 'AVAILABLE',
      isDeleted: false,
      name: 'Alice',
      avatar: '',
      bio: '',
    };
    const bob = {
      id: 2,
      account: 'bob',
      domain: 'local',
      availability: 'AVAILABLE',
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
    const service = new RelationshipService(
      {} as never,
      {} as never,
      { writeInTx } as never,
      {
        readP2PRelationshipInTx: vi.fn().mockResolvedValue({
          firstIntent: directions[0],
          secondIntent: directions[1],
          pair: { threadId: 7 },
        }),
      } as never,
    );
    const tx = {
      select: localRecipientQuery([alice, bob]),
      query: {
        account: {
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

    await service.writeRelationshipRequestClientStateInTx(tx as never, 1, 2);

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
      availability: 'AVAILABLE',
      isDeleted: false,
      name: 'Alice',
      avatar: '',
      bio: '',
    };
    const peer = {
      id: 2,
      account: 'bob',
      domain: 'peer.test',
      availability: 'AVAILABLE',
      isDeleted: false,
      name: 'Bob',
      avatar: '',
      bio: '',
    };
    const writeInTx = vi.fn().mockResolvedValue(1);
    const service = new RelationshipService(
      {} as never,
      {} as never,
      { writeInTx } as never,
      {
        readP2PRelationshipInTx: vi.fn().mockResolvedValue({
          firstIntent: undefined,
          secondIntent: {
            id: 12n,
            status: 'REQUESTED',
            note: '',
            requestedAt: new Date(1),
            expiresAt: new Date(Date.now() + 60_000),
          },
          pair: { threadId: null },
        }),
      } as never,
    );
    const tx = {
      select: localRecipientQuery([
        {
          id: 1,
          account: 'alice',
          domain: 'local',
          namespaceId: 0,
          availability: 'AVAILABLE',
        },
      ]),
      query: {
        account: {
          findFirst: vi.fn().mockResolvedValue(local),
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

    await service.writeRelationshipRequestClientStateInTx(tx as never, 1, {
      account: 'bob',
      domain: 'peer.test',
      namespaceId: 4,
    });

    expect(writeInTx).toHaveBeenCalledOnce();
    expect(writeInTx.mock.calls[0][1].body).toMatchObject({
      direction: 'INCOMING',
      status: 'REQUESTED',
      localThreadId: null,
    });
  });
});
