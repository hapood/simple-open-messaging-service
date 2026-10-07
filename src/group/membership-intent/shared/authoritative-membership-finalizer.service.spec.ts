import { account } from '../../../database/schema.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthoritativeMembershipFinalizerService } from './authoritative-membership-finalizer.service.js';

const audience = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
}));
const fanout = vi.hoisted(() => ({ enqueueCurrent: vi.fn() }));

vi.mock('../../../federation/federation-audience.js', () => ({
  openFederatedAudienceInTx: audience.open,
  closeFederatedAudienceInTx: audience.close,
}));
vi.mock('../../../message/thread-fanout-task.js', () => ({
  enqueueCurrentThreadFanoutsInTx: fanout.enqueueCurrent,
}));

function queryResult<T>(value: T) {
  const query: Record<string, unknown> = {};
  for (const method of [
    'from',
    'innerJoin',
    'leftJoin',
    'where',
    'limit',
    'orderBy',
  ])
    query[method] = vi.fn(() => query);
  query.then = (
    resolve: (result: T) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return query;
}

function harness(state: Record<string, unknown>) {
  const projectCurrentInTx = vi.fn().mockResolvedValue(true);
  const service = new AuthoritativeMembershipFinalizerService({
    projectCurrentInTx,
  } as never);
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const tx = {
    execute: vi.fn().mockImplementation(async (query) => {
      const compiled = new PgDialect().sqlToQuery(query);
      if (compiled.sql.includes('FROM "IdentityNamespace"')) {
        return { rows: [{ domain: 'peer.test' }] };
      }
      return { rows: [] };
    }),
    query: {
      account: { findFirst: vi.fn().mockResolvedValue({ account: 'alice' }) },
    },
    select: vi.fn(() => ({
      from: (table: unknown) =>
        queryResult(table === account ? [{ id: 11 }] : [state]),
    })),
    update: vi.fn(() => ({ set })),
  };
  return {
    service,
    tx,
    enqueueCurrentThreadFanoutsInTx: fanout.enqueueCurrent,
    projectCurrentInTx,
    set,
  };
}

const localState = {
  account: '!group',
  domain: 'local',
  namespaceId: 0,
  metaEndId: 12n,
};
const threadLock = { threadId: 7 } as never;

describe('AuthoritativeMembershipFinalizerService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the final local audience before admitting fan-out', async () => {
    const target = harness(localState);
    const openLocalAudienceInTx = vi.fn().mockResolvedValue(true);
    Object.assign(target.service, { openLocalAudienceInTx });

    await expect(
      target.service.finalizeInTx(target.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: 11,
        active: true,
        canonicalRosterChanged: true,
        threadLock,
      }),
    ).resolves.toEqual({ audienceChanged: true, threadFanoutAdmitted: true });

    expect(openLocalAudienceInTx).toHaveBeenCalledWith(target.tx, 7, 11, 12n);
    expect(target.enqueueCurrentThreadFanoutsInTx).toHaveBeenCalledWith(
      target.tx,
      expect.objectContaining({ threadId: 7 }),
    );
    expect(openLocalAudienceInTx.mock.invocationCallOrder[0]).toBeLessThan(
      target.enqueueCurrentThreadFanoutsInTx.mock.invocationCallOrder[0],
    );
  });

  it('closes local authorization without invalidating in-flight federation rounds', async () => {
    const target = harness(localState);
    const closeLocalAudienceInTx = vi.fn().mockResolvedValue(true);
    Object.assign(target.service, { closeLocalAudienceInTx });

    await expect(
      target.service.finalizeInTx(target.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: 11,
        active: false,
        canonicalRosterChanged: true,
        threadLock,
      }),
    ).resolves.toEqual({ audienceChanged: true, threadFanoutAdmitted: true });

    expect(target.tx.update).not.toHaveBeenCalled();
    expect(closeLocalAudienceInTx.mock.invocationCallOrder[0]).toBeLessThan(
      target.enqueueCurrentThreadFanoutsInTx.mock.invocationCallOrder[0],
    );
  });

  it.each([false, true])(
    'preserves the thread epoch when removing a peer member (remaining membership: %s)',
    async (active) => {
      const target = harness(localState);
      const execute = vi.fn().mockResolvedValue({ rows: [{ active }] });
      Object.assign(target.tx, { execute });
      audience.close.mockResolvedValueOnce(true);

      await expect(
        target.service.finalizeInTx(target.tx as never, {
          threadId: 7,
          groupId: 5,
          memberUserId: {
            account: 'alice',
            namespaceId: 9,
          },
          active: false,
          canonicalRosterChanged: true,
          threadLock,
        }),
      ).resolves.toEqual({
        audienceChanged: !active,
        threadFanoutAdmitted: true,
      });

      if (active) expect(audience.close).not.toHaveBeenCalled();
      else expect(audience.close).toHaveBeenCalledWith(target.tx, 9, 7);
      expect(target.tx.update).not.toHaveBeenCalled();
    },
  );

  it('does not author an audience or fan-out task for a mirror', async () => {
    const target = harness({
      ...localState,
      domain: 'origin.test',
      namespaceId: 9,
    });

    await expect(
      target.service.finalizeInTx(target.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: 11,
        active: true,
        canonicalRosterChanged: false,
        threadLock,
      }),
    ).resolves.toEqual({ audienceChanged: false, threadFanoutAdmitted: false });
    expect(target.enqueueCurrentThreadFanoutsInTx).not.toHaveBeenCalled();
  });

  it('opens a peer at the committed canonical floor before its task and content head', async () => {
    audience.open.mockResolvedValueOnce(true);
    const target = harness(localState);

    await expect(
      target.service.finalizeInTx(target.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: { account: 'alice', namespaceId: 9 },
        active: true,
        canonicalRosterChanged: true,
        threadLock,
      }),
    ).resolves.toEqual({ audienceChanged: true, threadFanoutAdmitted: true });

    expect(audience.open).toHaveBeenCalledWith(target.tx, 9, 7, 12n);
    expect(target.projectCurrentInTx).toHaveBeenCalledWith(
      target.tx,
      'peer.test',
      9,
      7,
    );
    expect(target.projectCurrentInTx.mock.invocationCallOrder[0]).toBeLessThan(
      target.enqueueCurrentThreadFanoutsInTx.mock.invocationCallOrder[0],
    );
  });

  it('publishes the content head when activation reuses a preauthorized audience', async () => {
    audience.open.mockResolvedValueOnce(false);
    const target = harness(localState);

    await expect(
      target.service.finalizeInTx(target.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: { account: 'alice', namespaceId: 9 },
        active: true,
        canonicalRosterChanged: true,
        threadLock,
      }),
    ).resolves.toEqual({ audienceChanged: false, threadFanoutAdmitted: true });

    expect(target.projectCurrentInTx).toHaveBeenCalledWith(
      target.tx,
      'peer.test',
      9,
      7,
    );
  });
});
