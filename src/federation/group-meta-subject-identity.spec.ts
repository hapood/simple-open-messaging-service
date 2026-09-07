import { describe, expect, it, vi } from 'vitest';
import { GroupMetaSyncTaskExecutionService } from './group-meta-sync-task-execution.service.js';
import { loadFederationConfig } from './federation.config.js';
import type { GroupMetaSyncTaskPayload } from './group-meta-sync-task.js';
import { GroupRole } from '../database/enums.js';

process.env.SOMS_DOMAIN ??= 'bravo.test';

const payload = { groupId: 5, namespaceId: 7 } as GroupMetaSyncTaskPayload;

function fixture(existing?: Record<string, unknown>) {
  const limit = vi.fn().mockResolvedValue(existing ? [existing] : []);
  const values = vi.fn().mockResolvedValue(undefined);
  const tx = {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })),
    insert: vi.fn(() => ({ values })),
  };
  const service = new GroupMetaSyncTaskExecutionService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, tx, values };
}

describe('Group Meta subject ingestion', () => {
  it.each(['UPSERT', 'DEPART'] as const)(
    'normalizes a local %s without looking up an Account',
    async (operation) => {
      const { service, tx, values } = fixture();
      const item = {
        feedId: 9n,
        account: 'unregistered',
        domain: loadFederationConfig().domain,
        operation,
        role: GroupRole.MEMBER,
        profileRev: 3,
      };
      await service['applyItemInTx'](tx as never, 1n, payload, 'delta', item);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 5,
          memberAccount: 'unregistered',
          memberDomain: 'local',
          memberNamespaceId: 0,
          operation,
        }),
      );
      expect(payload.namespaceId).toBe(7);
    },
  );

  it('retains the publisher namespace for a third-party member', async () => {
    const { service, tx, values } = fixture();
    await service['applyItemInTx'](tx as never, 1n, payload, 'delta', {
      feedId: 9n,
      account: 'alice',
      domain: 'charlie.test',
      operation: 'UPSERT',
      role: GroupRole.MEMBER,
      profileRev: 3,
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        memberAccount: 'alice',
        memberDomain: 'charlie.test',
        memberNamespaceId: 7,
      }),
    );
  });

  it('rejects an identity conflict at an already stored feed coordinate', async () => {
    const { service, tx, values } = fixture({
      account: 'bob',
      domain: 'charlie.test',
      namespaceId: 7,
      operation: 'DEPART',
      body: {},
    });
    await expect(
      service['applyItemInTx'](tx as never, 1n, payload, 'delta', {
        feedId: 9n,
        account: 'alice',
        domain: 'charlie.test',
        operation: 'DEPART',
      }),
    ).rejects.toThrow('conflicting group-meta member coordinate');
    expect(values).not.toHaveBeenCalled();
  });
});
