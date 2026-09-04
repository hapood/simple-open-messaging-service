import { describe, expect, it, vi } from 'vitest';
import { GroupInviteTaskExecutionService } from './group-invite-task-execution.service.js';

describe('GroupInviteTaskExecutionService', () => {
  it('revalidates friendship and manager authority before writing the invitation', async () => {
    const tx = {};
    const participants = {
      findP2PThreadBetween: vi.fn().mockResolvedValue(20),
    };
    const relationships = {
      writeGroupRelationshipIntentInTx: vi.fn().mockResolvedValue(new Map()),
    };
    const groups = {
      assertGroupManagerInTx: vi.fn().mockResolvedValue(undefined),
    };
    const invites = {
      createGroupInvite: vi.fn(
        async (
          _actor: number,
          _threadId: number,
          _member: number,
          _note: string,
          afterWrite: (value: object) => Promise<void>,
        ) => afterWrite(tx),
      ),
    };
    const service = new GroupInviteTaskExecutionService(
      invites as never,
      participants as never,
      relationships as never,
      { pushStateFeedDomains: vi.fn().mockResolvedValue(undefined) } as never,
      { notifyFeedUpdates: vi.fn() } as never,
      groups as never,
    );

    await service.inviteMember(7, 10, 8);

    expect(groups.assertGroupManagerInTx).toHaveBeenCalledWith(tx, 10, 7);
    expect(relationships.writeGroupRelationshipIntentInTx).toHaveBeenCalled();
  });

  it('rejects execution when the target is no longer a friend', async () => {
    const service = new GroupInviteTaskExecutionService(
      { createGroupInvite: vi.fn() } as never,
      { findP2PThreadBetween: vi.fn().mockResolvedValue(null) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.inviteMember(7, 10, 8)).rejects.toMatchObject({
      bizCode: expect.any(Number),
    });
  });
});
