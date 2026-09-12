import { account } from '../database/schema.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthoritativeGroupMembershipFinalizer } from './authoritative-group-membership-finalizer.service.js';

const audience = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
}));

vi.mock('./federation-audience.js', () => ({
  openFederatedAudienceInTx: audience.open,
  closeFederatedAudienceInTx: audience.close,
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
  const enqueueGroupMetaHeadFanoutInTx = vi.fn().mockResolvedValue({
    taskId: 4n,
  });
  const refreshInTx = vi.fn().mockResolvedValue(undefined);
  const service = new AuthoritativeGroupMembershipFinalizer(
    { enqueueGroupMetaHeadFanoutInTx } as never,
    { refreshInTx } as never,
  );
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const tx = {
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
    enqueueGroupMetaHeadFanoutInTx,
    refreshInTx,
    set,
  };
}

const localState = {
  account: '!group',
  domain: 'local',
  namespaceId: 0,
  metaEndId: 12n,
  memberDomain: 'local',
  memberNamespaceId: 0,
};

describe('AuthoritativeGroupMembershipFinalizer', () => {
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
      }),
    ).resolves.toEqual({ audienceChanged: true, fanoutTaskCreated: true });

    expect(openLocalAudienceInTx).toHaveBeenCalledWith(target.tx, 7, 11, 12n);
    expect(target.enqueueGroupMetaHeadFanoutInTx).toHaveBeenCalledWith(
      target.tx,
      {
        group: { account: '!group', domain: 'local' },
        threadId: 7,
      },
    );
    expect(openLocalAudienceInTx.mock.invocationCallOrder[0]).toBeLessThan(
      target.enqueueGroupMetaHeadFanoutInTx.mock.invocationCallOrder[0],
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
      }),
    ).resolves.toEqual({ audienceChanged: true, fanoutTaskCreated: true });

    expect(target.tx.update).not.toHaveBeenCalled();
    expect(closeLocalAudienceInTx.mock.invocationCallOrder[0]).toBeLessThan(
      target.enqueueGroupMetaHeadFanoutInTx.mock.invocationCallOrder[0],
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
            domain: 'peer.test',
            namespaceId: 9,
          },
          active: false,
          canonicalRosterChanged: true,
        }),
      ).resolves.toEqual({ audienceChanged: !active, fanoutTaskCreated: true });

      if (active) expect(audience.close).not.toHaveBeenCalled();
      else
        expect(audience.close).toHaveBeenCalledWith(target.tx, 'peer.test', 7);
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
      }),
    ).resolves.toEqual({ audienceChanged: false, fanoutTaskCreated: false });
    expect(target.enqueueGroupMetaHeadFanoutInTx).not.toHaveBeenCalled();
  });

  it('opens a peer at the committed canonical floor before its task and content head', async () => {
    audience.open.mockResolvedValueOnce(true);
    const target = harness({
      ...localState,
      memberDomain: 'peer.test',
      memberNamespaceId: 9,
    });

    await expect(
      target.service.finalizeInTx(target.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: { account: 'alice', domain: 'peer.test', namespaceId: 9 },
        active: true,
        canonicalRosterChanged: true,
      }),
    ).resolves.toEqual({ audienceChanged: true, fanoutTaskCreated: true });

    expect(audience.open).toHaveBeenCalledWith(target.tx, 'peer.test', 7, 12n);
    expect(target.refreshInTx).toHaveBeenCalledWith(
      target.tx,
      'peer.test',
      9,
      7,
    );
    expect(target.refreshInTx.mock.invocationCallOrder[0]).toBeLessThan(
      target.enqueueGroupMetaHeadFanoutInTx.mock.invocationCallOrder[0],
    );
  });

  it('publishes the content head when activation reuses a preauthorized audience', async () => {
    audience.open.mockResolvedValueOnce(false);
    const target = harness({
      ...localState,
      memberDomain: 'peer.test',
      memberNamespaceId: 9,
    });

    await expect(
      target.service.finalizeInTx(target.tx as never, {
        threadId: 7,
        groupId: 5,
        memberUserId: { account: 'alice', domain: 'peer.test', namespaceId: 9 },
        active: true,
        canonicalRosterChanged: true,
      }),
    ).resolves.toEqual({ audienceChanged: false, fanoutTaskCreated: true });

    expect(target.refreshInTx).toHaveBeenCalledWith(
      target.tx,
      'peer.test',
      9,
      7,
    );
  });
});
