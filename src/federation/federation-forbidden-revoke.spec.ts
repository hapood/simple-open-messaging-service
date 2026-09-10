import { describe, expect, it, vi } from 'vitest';
import { FederationThreadQueryDenialService } from './federation-thread-query-denial.service.js';
import { businessAccountScopeKey } from '../relationship/business-scope-lock.js';
import { requireThreadContentLockInTx } from '../relationship/thread-content-lock.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';

vi.mock('../relationship/thread-content-lock.js', () => ({
  requireThreadContentLockInTx: vi.fn().mockResolvedValue({ threadId: 12 }),
}));

describe('forced query-denial revocation', () => {
  function harness(domain: string, epoch = 8) {
    const group = {
      account: '!group',
      domain,
      namespaceId: domain === 'local' ? 0 : 5,
      authorizationEpoch: epoch,
    };
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [group] }) };
    const writeMemberRelationshipIntentInTx = vi
      .fn()
      .mockResolvedValue(new Map([['peer.test', 3n]]));
    const writeGroupRelationshipIntentInTx = vi
      .fn()
      .mockResolvedValue(new Map([['peer.test', 3n]]));
    const notifyFeedUpdates = vi.fn();
    const emit = vi.fn();
    const service = new FederationThreadQueryDenialService(
      {
        db: { transaction: (run: (tx: unknown) => unknown) => run(tx) },
      } as never,
      {} as never,
      {
        writeMemberRelationshipIntentInTx,
        writeGroupRelationshipIntentInTx,
      } as never,
      { notifyFeedUpdates } as never,
      { emit } as never,
      {} as never,
    );
    const task = {
      scopeType: 'GROUP',
      scopeKey: businessAccountScopeKey(group),
      taskType: 'FORCE_REVOKE_GROUP_MEMBER',
      payload: {
        threadId: 12,
        peerDomain: 'peer.test',
        namespaceId: 5,
        expectedAuthorizationEpoch: 8,
        direction: domain === 'local' ? 'GROUP' : 'MEMBER',
        memberUserId:
          domain === 'local'
            ? { account: 'remote', domain: 'peer.test', namespaceId: 5 }
            : 7,
      },
    } as unknown as DurableTask;
    return {
      service,
      tx,
      task,
      writeMemberRelationshipIntentInTx,
      writeGroupRelationshipIntentInTx,
      emit,
      notifyFeedUpdates,
    };
  }

  it.each(['local', 'peer.test'])(
    'uses the existing writer for %s ownership',
    async (domain) => {
      const h = harness(domain);
      await h.service.revokeForbiddenMember(h.task);
      expect(requireThreadContentLockInTx).toHaveBeenCalledWith(h.tx, 12);
      expect(h.writeMemberRelationshipIntentInTx).toHaveBeenCalledTimes(
        domain === 'local' ? 0 : 1,
      );
      expect(h.writeGroupRelationshipIntentInTx).toHaveBeenCalledTimes(
        domain === 'local' ? 1 : 0,
      );
      expect(h.emit).toHaveBeenCalledOnce();
    },
  );

  it('does not write a relationship after its authorization epoch changes', async () => {
    const h = harness('peer.test', 9);
    await h.service.revokeForbiddenMember(h.task);
    expect(h.writeMemberRelationshipIntentInTx).not.toHaveBeenCalled();
    expect(h.writeGroupRelationshipIntentInTx).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('rejects an opposite-direction payload instead of changing that intent', async () => {
    const h = harness('peer.test');
    h.task.payload.direction = 'GROUP';
    await expect(h.service.revokeForbiddenMember(h.task)).rejects.toThrow(
      'invalid denied member direction',
    );
    expect(h.writeMemberRelationshipIntentInTx).not.toHaveBeenCalled();
    expect(h.notifyFeedUpdates).not.toHaveBeenCalled();
  });
});
