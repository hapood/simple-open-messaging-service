import {
  applyFederatedPendingProfileSnapshot,
  RelationshipService,
} from './relationship.service.js';
import { describe, expect, it, vi } from 'vitest';
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
  return (fields?: { threadFeedEndId?: unknown }) =>
    fields?.threadFeedEndId
      ? {
          from: () => ({
            innerJoin: () => ({
              where: async () =>
                rows.map((row) => ({
                  userId: (row as { id: number }).id,
                  feedId: 10,
                  threadFeedEndId: 4,
                })),
            }),
            where: async () =>
              rows.map((row) => ({
                userId: (row as { id: number }).id,
                feedId: 10,
                threadFeedEndId: 4,
              })),
          }),
        }
      : {
          from: () => ({
            innerJoin: () => ({
              where: () => ({ orderBy: async () => rows }),
            }),
            where: () => ({ orderBy: async () => rows }),
          }),
        };
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
    const tx = {
      execute: vi.fn().mockImplementation(async (query) => {
        const compiled = new PgDialect().sqlToQuery(query);
        if (compiled.sql.includes('FROM "IdentityNamespace"')) {
          const id = compiled.params[0] as number;
          return { rows: [{ domain: id === 0 ? 'local' : 'remote.test' }] };
        }
        return { rows: [] };
      }),
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
              displayName: `Selected ${params.at(-1)}`,
              avatar: `avatar-${params.at(-1)}`,
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
    );
    return { service, tx, writeInTx };
  }

  it('uses the peer-authored intent revision in both directions, never either user default', async () => {
    const { service, tx, writeInTx } = setup(7);
    await service.writeRelationshipRequestClientStateInTx(tx as never, 1, {
      account: 'bob',
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
      ['bob', 4, 4, 7],
      ['bob', 4, 4, 7],
    ]);
  });

  it('retains the exact reference and an empty image when the version is not materialized', async () => {
    const { service, tx, writeInTx } = setup(7, false);
    await service.writeRelationshipRequestClientStateInTx(tx as never, 1, {
      account: 'bob',
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
      namespaceId: 4,
    });
    expect(writeInTx.mock.calls[0][1].body.peer).toMatchObject({
      profileRev: 0,
      name: 'bob',
      avatar: '',
    });
  });
});

describe('RelationshipService P2P shell GC', () => {
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
      execute: vi
        .fn()
        .mockResolvedValue({ rows: [{ domain: 'chat.example' }] }),
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
          domain: 'chat.example',
          subjectAccount: 'bob',
          subjectNamespaceId: 0,
          body: expect.objectContaining({
            direction: 'OUTGOING',
            status: 'ACCEPTED',
            localThreadId: 7,
          }),
        }),
        expect.objectContaining({
          account: 'bob',
          domain: 'chat.example',
          subjectAccount: 'alice',
          subjectNamespaceId: 0,
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
            `${write.domain}\0${write.account}\0${write.subjectNamespaceId}\0${write.subjectAccount}`,
        ),
      ).size,
    ).toBe(2);
    expect(ownerOne.every((write) => write.body.localThreadId === 7)).toBe(
      true,
    );
    expect(
      ownerOne.every((write) => write.body.peer.domain === 'chat.example'),
    ).toBe(true);
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
    const writeInTx = vi.fn().mockResolvedValue(1);
    const service = new RelationshipService(
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
      execute: vi.fn().mockImplementation(async (query) => {
        const compiled = new PgDialect().sqlToQuery(query);
        if (compiled.sql.includes('FROM "IdentityNamespace"')) {
          return { rows: [{ domain: 'peer.test' }] };
        }
        return { rows: [] };
      }),
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
