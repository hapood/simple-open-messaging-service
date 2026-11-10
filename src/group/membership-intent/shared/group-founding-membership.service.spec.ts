import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { captureThreadStateUpdatesInTx } from '../../../client-state-feed/capture-thread-state-updates.js';
import { GroupRole } from '../../../database/enums.js';
import { GroupRelationshipMutationService } from './group-relationship-mutation.service.js';

vi.mock('../../../client-state-feed/capture-thread-state-updates.js', () => ({
  captureThreadStateUpdatesInTx: vi.fn(),
}));

function harness() {
  const group = {
    account: '!group',
    namespaceId: 0,
    profileRev: 0,
    dissolvedAt: null as Date | null,
    threadDissolvedAt: null as Date | null,
  };
  const creator = { account: 'owner', namespaceId: 0, defaultProfileRev: 2 };
  const limit = vi.fn().mockResolvedValue([group]);
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })),
      })),
    })),
    execute: vi.fn().mockResolvedValue({ rows: [{ present: false }] }),
    query: {
      account: { findFirst: vi.fn().mockResolvedValue(creator) },
      profileTable: { findFirst: vi.fn().mockResolvedValue({ profileRev: 2 }) },
    },
  };
  const threadLock = { tx, threadId: 7 };
  const intents = {
    lockGroupMutationInTx: vi.fn().mockResolvedValue({ id: 3n, threadLock }),
  };
  const fold = { writeLockedAuthoredIntentInTx: vi.fn().mockResolvedValue({}) };
  const requests = { openRequestInTx: vi.fn(), concludeRequestInTx: vi.fn() };
  const service = new GroupRelationshipMutationService(
    intents as never,
    requests as never,
    {} as never,
    {} as never,
    {} as never,
    fold as never,
  );
  const effects = vi.spyOn(service, 'writeGroupRequestEffectsInTx');
  const pending = [
    { kind: 'thread-feed' as const, userId: 11, feedId: 8, threadFeedEndId: 9 },
  ];
  vi.mocked(captureThreadStateUpdatesInTx)
    .mockReset()
    .mockResolvedValue(pending);
  const updates: typeof pending = [];
  const initialize = () =>
    service.initializeFoundingMembershipInTx(tx as never, 7, 11, updates);
  return {
    group,
    creator,
    tx,
    limit,
    threadLock,
    intents,
    fold,
    requests,
    effects,
    pending,
    updates,
    initialize,
  };
}

describe('GroupRelationshipMutationService founding membership', () => {
  it.each([0, 2])(
    'seeds accepted owner directions without any request effects (profile revision %i)',
    async (revision) => {
      const h = harness();
      h.creator.defaultProfileRev = revision;
      await h.initialize();

      expect(h.intents.lockGroupMutationInTx).toHaveBeenCalledExactlyOnceWith(
        h.tx,
        {
          threadId: 7,
          groupId: 7,
          memberUserId: 11,
          feedAllocatorUserIds: [11],
        },
      );
      expect(
        h.intents.lockGroupMutationInTx.mock.invocationCallOrder[0],
      ).toBeLessThan(h.tx.select.mock.invocationCallOrder[0]!);
      expect(h.tx.query.profileTable.findFirst).toHaveBeenCalledTimes(
        revision === 0 ? 0 : 1,
      );
      if (revision > 0)
        expect(h.tx.query.profileTable.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ columns: { profileRev: true } }),
        );
      const memberDirection = {
        authorAccount: 'owner',
        authorNamespaceId: 0,
        receiverAccount: '!group',
        receiverNamespaceId: 0,
      };
      const common = {
        threadId: 7,
        groupId: 7,
        memberUserId: 11,
        pairId: 3n,
        threadLock: h.threadLock,
        memberLocal: true,
        hostedLocally: true,
        memberDirection,
        status: 'ACCEPTED',
        snapshot: null,
        initialRole: GroupRole.OWNER,
      };
      expect(h.fold.writeLockedAuthoredIntentInTx).toHaveBeenNthCalledWith(
        1,
        h.tx,
        {
          ...common,
          author: 'GROUP',
          validatedPairActive: false,
          direction: {
            authorAccount: '!group',
            authorNamespaceId: 0,
            receiverAccount: 'owner',
            receiverNamespaceId: 0,
          },
        },
      );
      expect(h.fold.writeLockedAuthoredIntentInTx).toHaveBeenNthCalledWith(
        2,
        h.tx,
        {
          ...common,
          author: 'MEMBER',
          direction: memberDirection,
        },
      );
      expect(h.fold.writeLockedAuthoredIntentInTx).toHaveBeenCalledTimes(2);
      expect(h.requests.openRequestInTx).not.toHaveBeenCalled();
      expect(h.requests.concludeRequestInTx).not.toHaveBeenCalled();
      expect(h.effects).not.toHaveBeenCalled();
      expect(captureThreadStateUpdatesInTx).toHaveBeenCalledExactlyOnceWith(
        h.tx,
        [11],
      );
      expect(
        h.fold.writeLockedAuthoredIntentInTx.mock.invocationCallOrder[1],
      ).toBeLessThan(
        vi.mocked(captureThreadStateUpdatesInTx).mock.invocationCallOrder[0]!,
      );
      expect(h.updates).toEqual(h.pending);
    },
  );

  it.each([
    [
      'missing group',
      (h: ReturnType<typeof harness>) => h.limit.mockResolvedValue([]),
    ],
    [
      'remote group',
      (h: ReturnType<typeof harness>) => {
        h.group.namespaceId = 4;
      },
    ],
    [
      'published group',
      (h: ReturnType<typeof harness>) => {
        h.group.profileRev = 1;
      },
    ],
    [
      'dissolved group',
      (h: ReturnType<typeof harness>) => {
        h.group.dissolvedAt = new Date();
      },
    ],
    [
      'dissolved thread',
      (h: ReturnType<typeof harness>) => {
        h.group.threadDissolvedAt = new Date();
      },
    ],
  ] as const)('rejects %s before folding', async (_, setup) => {
    const h = harness();
    setup(h);
    await expect(h.initialize()).rejects.toThrow('unpublished local group');
    expect(h.fold.writeLockedAuthoredIntentInTx).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });

  it.each([
    [
      'missing creator',
      (h: ReturnType<typeof harness>) =>
        h.tx.query.account.findFirst.mockResolvedValue(undefined),
      'local account',
    ],
    [
      'remote creator',
      (h: ReturnType<typeof harness>) => {
        h.creator.namespaceId = 4;
      },
      'local account',
    ],
    [
      'invalid revision',
      (h: ReturnType<typeof harness>) => {
        h.creator.defaultProfileRev = -1;
      },
      'profile revision is invalid',
    ],
    [
      'missing profile evidence',
      (h: ReturnType<typeof harness>) =>
        h.tx.query.profileTable.findFirst.mockResolvedValue(undefined),
      'profile is unavailable',
    ],
  ] as const)('rejects %s', async (_, setup, error) => {
    const h = harness();
    setup(h);
    await expect(h.initialize()).rejects.toThrow(error);
    expect(h.fold.writeLockedAuthoredIntentInTx).not.toHaveBeenCalled();
  });

  it('rejects existing membership, including other owners and departed membership history', async () => {
    const h = harness();
    h.tx.execute.mockResolvedValue({ rows: [{ present: true }] });
    await expect(h.initialize()).rejects.toThrow('pristine membership state');
    const query = new PgDialect().sqlToQuery(h.tx.execute.mock.calls[0]![0]);
    expect(query.sql).toContain('id <>');
    expect(query.sql).toContain('OR active OR established');
    expect(query.sql).toContain('FROM "RelationshipIntent"');
    expect(query.sql).toContain(
      "operation IN ('MEMBER_UPSERT', 'MEMBER_DEPART')",
    );
    expect(query.sql).toContain('FROM "AccountThreadState"');
    expect(h.fold.writeLockedAuthoredIntentInTx).not.toHaveBeenCalled();
    expect(captureThreadStateUpdatesInTx).not.toHaveBeenCalled();
  });
});
