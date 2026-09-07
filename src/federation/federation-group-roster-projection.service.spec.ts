import { requireGroupThreadContentLockUnderGroupInTx } from '../relationship/thread-content-lock.js';
import { describe, expect, it, vi } from 'vitest';
import { FederationGroupRosterProjectionService } from './federation-group-roster-projection.service.js';

describe('FederationGroupRosterProjectionService', () => {
  it('commits roster metadata without resolving triples to User rows', async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        groupId: 5,
        threadId: 3,
      },
    ]);
    const select = vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit }) }),
      }),
    }));
    const where = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn(() => ({ set: () => ({ where }) }));
    const execute = vi.fn().mockResolvedValue({ rows: [{ id: 3 }] });
    const insert = vi.fn();
    const remove = vi.fn();
    const service = new FederationGroupRosterProjectionService();

    const tx = { select, update, execute, insert, delete: remove };
    const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
      tx as never,
      5,
      3,
    );
    execute.mockClear();
    const result = await service.applyInTx(tx as never, {
      threadLock,
      peerDomain: 'origin.example',
      namespaceId: 7,
      groupAccount: '!group',
      active: true,
      dissolved: false,
      owner: { account: 'owner', domain: 'origin.example' },
      changes: [
        {
          account: 'alice',
          domain: 'local.example',
          beforeRole: null,
          afterRole: 'MEMBER',
        },
      ],
    });

    expect(execute).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(result.users).toEqual([]);
  });
});
