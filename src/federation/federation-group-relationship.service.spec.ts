vi.mock('./federation-relationship-thread-state.js', () => ({
  initializeRelationshipThreadStateInTx: vi.fn(),
}));
import { describe, expect, it, vi } from 'vitest';
import { GroupRole } from '../database/enums.js';
import { FederationGroupRelationshipService } from './federation-group-relationship.service.js';

describe('FederationGroupRelationshipService', () => {
  it('materializes the folded active result of an authored intent', async () => {
    const request = {
      status: 'ACCEPTED' as const,
      note: '',
      requestedAt: new Date(),
      expiresAt: null,
    };
    const relationshipIntents = {
      lockGroupMutationInTx: vi
        .fn()
        .mockResolvedValue({ id: 1n, threadLock: {} }),
      writeGroupAuthoredIntentInTx: vi.fn().mockResolvedValue({
        request,
        shouldBeActive: true,
        changed: true,
      }),
      setGroupPairActiveInTx: vi.fn().mockResolvedValue(true),
      readGroupMemberProfileRevInTx: vi.fn().mockResolvedValue(4),
    };
    const groupMembership = {
      syncFromActiveInTx: vi
        .fn()
        .mockResolvedValue({ canonicalRosterChanged: true }),
    };
    const membershipFinalizer = {
      finalizeInTx: vi.fn().mockResolvedValue({
        audienceChanged: true,
        fanoutTaskCreated: true,
      }),
    };
    const service = new FederationGroupRelationshipService(
      relationshipIntents as never,
      groupMembership as never,
      membershipFinalizer as never,
    );

    const initialize = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, {
      previews: { initializeReadWindowsInTx: initialize },
    });
    const result = await service.writeAuthoredIntentInTx({} as never, {
      threadId: 3,
      groupId: 5,
      memberUserId: 7,
      author: 'MEMBER',
      hostedLocally: true,
      status: 'ACCEPTED',
      initialRole: GroupRole.OWNER,
    });

    expect(relationshipIntents.setGroupPairActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      { groupId: 5, memberUserId: 7, threadId: 3, active: true },
    );
    expect(groupMembership.syncFromActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      {
        threadId: 3,
        groupId: 5,
        memberUserId: 7,
        active: true,
        hostedLocally: true,
        memberProfileRev: 4,
        initialRole: 'OWNER',
      },
    );
    expect(result).toEqual(
      expect.objectContaining({
        active: true,
        pairChanged: true,
        canonicalRosterChanged: true,
        audienceChanged: true,
        fanoutTaskCreated: true,
      }),
    );
    expect(initialize).toHaveBeenCalledWith(expect.anything(), 3, [7]);
    expect(
      groupMembership.syncFromActiveInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(initialize.mock.invocationCallOrder[0]);
    expect(initialize.mock.invocationCallOrder[0]).toBeLessThan(
      membershipFinalizer.finalizeInTx.mock.invocationCallOrder[0],
    );
    initialize.mockClear();
    relationshipIntents.setGroupPairActiveInTx.mockResolvedValue(false);
    await service.syncActiveInTx({} as never, {
      threadId: 3,
      groupId: 5,
      memberUserId: 7,
      active: true,
      hostedLocally: true,
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(membershipFinalizer.finalizeInTx).toHaveBeenCalledWith(
      expect.anything(),
      {
        threadId: 3,
        groupId: 5,
        memberUserId: 7,
        active: true,
        canonicalRosterChanged: true,
      },
    );
    expect(
      groupMembership.syncFromActiveInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(
      membershipFinalizer.finalizeInTx.mock.invocationCallOrder[0],
    );
  });

  it('forces a revoked authored intent inactive before deleting its member projection', async () => {
    const relationshipIntents = {
      lockGroupMutationInTx: vi
        .fn()
        .mockResolvedValue({ id: 1n, threadLock: {} }),
      writeGroupAuthoredIntentInTx: vi.fn().mockResolvedValue({
        request: {
          status: 'REVOKED',
          note: '',
          requestedAt: null,
          expiresAt: null,
        },
        shouldBeActive: true,
        changed: true,
      }),
      setGroupPairActiveInTx: vi.fn().mockResolvedValue(true),
    };
    const groupMembership = {
      syncFromActiveInTx: vi
        .fn()
        .mockResolvedValue({ canonicalRosterChanged: true }),
    };
    const membershipFinalizer = {
      finalizeInTx: vi.fn().mockResolvedValue({
        audienceChanged: true,
        fanoutTaskCreated: true,
      }),
    };
    const service = new FederationGroupRelationshipService(
      relationshipIntents as never,
      groupMembership as never,
      membershipFinalizer as never,
    );

    await service.writeAuthoredIntentInTx({} as never, {
      threadId: 3,
      groupId: 5,
      memberUserId: 7,
      author: 'GROUP',
      hostedLocally: true,
      status: 'REVOKED',
    });

    expect(relationshipIntents.setGroupPairActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      { groupId: 5, memberUserId: 7, threadId: 3, active: false },
    );
    expect(groupMembership.syncFromActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      {
        threadId: 3,
        groupId: 5,
        memberUserId: 7,
        active: false,
        hostedLocally: true,
      },
    );
  });

  it('runs the departure boundary effect after pair deactivation and before member removal', async () => {
    const relationshipIntents = {
      lockGroupMutationInTx: vi
        .fn()
        .mockResolvedValue({ id: 1n, threadLock: {} }),
      setGroupPairActiveInTx: vi.fn().mockResolvedValue(true),
    };
    const groupMembership = {
      syncFromActiveInTx: vi
        .fn()
        .mockResolvedValue({ canonicalRosterChanged: true }),
    };
    const membershipFinalizer = {
      finalizeInTx: vi.fn().mockResolvedValue({
        audienceChanged: true,
        fanoutTaskCreated: true,
      }),
    };
    const afterPairDeactivated = vi.fn().mockResolvedValue('boundary');
    const service = new FederationGroupRelationshipService(
      relationshipIntents as never,
      groupMembership as never,
      membershipFinalizer as never,
    );

    const result = await service.deactivateAfterInTx({} as never, {
      threadId: 3,
      groupId: 5,
      memberUserId: 7,
      hostedLocally: true,
      afterPairDeactivated,
    });

    expect(result).toEqual({
      pairChanged: true,
      canonicalRosterChanged: true,
      audienceChanged: true,
      fanoutTaskCreated: true,
      effect: 'boundary',
    });
    expect(
      relationshipIntents.setGroupPairActiveInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(afterPairDeactivated.mock.invocationCallOrder[0]);
    expect(afterPairDeactivated.mock.invocationCallOrder[0]).toBeLessThan(
      groupMembership.syncFromActiveInTx.mock.invocationCallOrder[0],
    );
  });

  it('does not derive a member for a group hosted by another server', async () => {
    const relationshipIntents = {
      lockGroupMutationInTx: vi
        .fn()
        .mockResolvedValue({ id: 1n, threadLock: {} }),
      setGroupPairActiveInTx: vi.fn().mockResolvedValue(true),
    };
    const groupMembership = {
      syncFromActiveInTx: vi
        .fn()
        .mockResolvedValue({ canonicalRosterChanged: false }),
    };
    const membershipFinalizer = {
      finalizeInTx: vi.fn().mockResolvedValue({
        audienceChanged: false,
        fanoutTaskCreated: false,
      }),
    };
    const service = new FederationGroupRelationshipService(
      relationshipIntents as never,
      groupMembership as never,
      membershipFinalizer as never,
    );
    Object.assign(service, {
      previews: {
        initializeReadWindowsInTx: vi.fn().mockResolvedValue(undefined),
      },
    });

    await service.syncActiveInTx({} as never, {
      threadId: 3,
      groupId: 5,
      memberUserId: 7,
      active: true,
      hostedLocally: false,
    });

    expect(relationshipIntents.setGroupPairActiveInTx).toHaveBeenCalledOnce();
    expect(groupMembership.syncFromActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      {
        threadId: 3,
        groupId: 5,
        memberUserId: 7,
        active: true,
        hostedLocally: false,
      },
    );
  });
});
