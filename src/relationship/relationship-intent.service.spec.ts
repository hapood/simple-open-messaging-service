import { describe, expect, it, vi } from 'vitest';
import { RelationshipIntentService } from './relationship-intent.service.js';

function transaction(pairChanged: boolean) {
  const forUpdate = vi.fn().mockResolvedValue([]);
  const orderBy = vi.fn().mockReturnValue({ for: forUpdate });
  const whereSelect = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where: whereSelect });
  const select = vi.fn().mockReturnValue({ from });

  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });

  const whereUpdate = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where: whereUpdate });
  const update = vi.fn().mockReturnValue({ set });

  const execute = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [
        {
          groupAccount: '!group',
          groupDomain: 'peer.test',
          memberAccount: 'alice',
          memberDomain: 'local',
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          groupAccount: '!group',
          groupDomain: 'peer.test',
          memberAccount: 'alice',
          memberDomain: 'local',
        },
      ],
    })
    .mockResolvedValueOnce({ rows: [{ id: 31 }] })
    .mockResolvedValueOnce({
      rows: [{ id: 9n, active: !pairChanged, threadId: 31 }],
    })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rowCount: pairChanged ? 1 : 0, rows: [] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [] });

  return {
    tx: { select, insert, update, execute },
    execute,
    forUpdate,
  };
}

describe('RelationshipIntentService remote-group authorization epoch', () => {
  it('serializes an activating group pair change without maintaining a duplicate aggregate', async () => {
    const { tx, execute, forUpdate } = transaction(true);
    const service = new RelationshipIntentService();

    await expect(
      service.setGroupPairActiveInTx(tx as never, {
        groupId: 5,
        memberUserId: 7,
        threadId: 31,
        active: true,
      }),
    ).resolves.toBe(true);

    expect(forUpdate).toHaveBeenCalledWith('update');
    expect(execute).toHaveBeenCalledTimes(7);
  });

  it('does not write another aggregate when pair.active is unchanged', async () => {
    const { tx, execute } = transaction(false);
    const service = new RelationshipIntentService();

    await expect(
      service.setGroupPairActiveInTx(tx as never, {
        groupId: 5,
        memberUserId: 7,
        threadId: 31,
        active: true,
      }),
    ).resolves.toBe(false);

    expect(execute).toHaveBeenCalledTimes(7);
  });

  it('checks the thread epoch after a remote-group member deactivation', async () => {
    const { tx, execute } = transaction(true);
    const service = new RelationshipIntentService();

    await expect(
      service.setGroupPairActiveInTx(tx as never, {
        groupId: 5,
        memberUserId: 7,
        threadId: 31,
        active: false,
      }),
    ).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(execute.mock.calls[7]![0])).toContain(
      'authorizationEpoch',
    );
    expect(JSON.stringify(execute.mock.calls[7]![0])).toContain('NOT EXISTS');
  });
});

describe('RelationshipIntentService thread authorization epoch', () => {
  it('increments the thread epoch after an effective P2P deactivation', async () => {
    const service = new RelationshipIntentService();
    vi.spyOn(
      service as never,
      'lockUserPairMutationInTx' as never,
    ).mockResolvedValue({ id: 9n, active: true, threadId: 31 } as never);
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ revision: 2n }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 31 }] });

    await expect(
      service.setPairActiveInTx({ execute } as never, 1, 2, false),
    ).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not increment the thread epoch for a repeated inactive write', async () => {
    const service = new RelationshipIntentService();
    vi.spyOn(
      service as never,
      'lockUserPairMutationInTx' as never,
    ).mockResolvedValue({ id: 9n, active: false, threadId: 31 } as never);
    const execute = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(
      service.setPairActiveInTx({ execute } as never, 1, 2, false),
    ).resolves.toBe(false);

    expect(execute).toHaveBeenCalledOnce();
  });
});
