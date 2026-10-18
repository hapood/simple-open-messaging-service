vi.mock('../../../federation/federation-relationship-thread-state.js', () => ({
  initializeRelationshipThreadStateInTx: vi.fn(),
}));
import { describe, expect, it, vi } from 'vitest';
import { GroupRole } from '../../../database/enums.js';
import { GroupRelationshipFoldService } from './group-relationship-fold.service.js';

describe('GroupRelationshipFoldService', () => {
  it('materializes the folded active result of an authored intent', async () => {
    const request = {
      status: 'ACCEPTED' as const,
      note: '',
      requestedAt: new Date(),
      expiresAt: null,
    };
    const relationshipIntents = {
      lockGroupMutationInTx: vi.fn().mockResolvedValue({
        id: 1n,
        endpointA: { type: 'GROUP', account: '!group', namespaceId: 0 },
        endpointB: { type: 'USER', account: 'alice', namespaceId: 0 },
        threadLock: {},
      }),
      writeLockedGroupAuthoredIntentInTx: vi.fn().mockResolvedValue({
        request,
        shouldBeActive: true,
        changed: true,
      }),
      setLockedGroupPairActiveInTx: vi.fn().mockResolvedValue(true),
      readLockedGroupMemberProfileRevInTx: vi.fn().mockResolvedValue(4),
    };
    const groupMembership = {
      syncFromActiveInTx: vi
        .fn()
        .mockResolvedValue({ canonicalRosterChanged: true }),
    };
    const membershipFinalizer = {
      finalizeInTx: vi.fn().mockResolvedValue({
        audienceChanged: true,
        threadFanoutAdmitted: true,
      }),
    };
    const service = new GroupRelationshipFoldService(
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
      snapshot: null,
      initialRole: GroupRole.OWNER,
    });

    expect(
      relationshipIntents.setLockedGroupPairActiveInTx,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pairId: 1n, threadId: 3, active: true }),
    );
    expect(groupMembership.syncFromActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      {
        threadId: 3,
        groupId: 5,
        memberUserId: 7,
        active: true,
        pairChanged: true,
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
        threadFanoutAdmitted: true,
      }),
    );
    expect(initialize).toHaveBeenCalledWith(
      expect.anything(),
      3,
      [7],
      expect.anything(),
    );
    expect(
      groupMembership.syncFromActiveInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(initialize.mock.invocationCallOrder[0]);
    expect(initialize.mock.invocationCallOrder[0]).toBeLessThan(
      membershipFinalizer.finalizeInTx.mock.invocationCallOrder[0],
    );
    initialize.mockClear();
    relationshipIntents.setLockedGroupPairActiveInTx.mockResolvedValue(false);
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
        threadLock: expect.anything(),
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
      lockGroupMutationInTx: vi.fn().mockResolvedValue({
        id: 1n,
        endpointA: { type: 'GROUP', account: '!group', namespaceId: 0 },
        endpointB: { type: 'USER', account: 'alice', namespaceId: 0 },
        threadLock: {},
      }),
      writeLockedGroupAuthoredIntentInTx: vi.fn().mockResolvedValue({
        request: {
          status: 'REVOKED',
          note: '',
          requestedAt: null,
          expiresAt: null,
        },
        shouldBeActive: true,
        changed: true,
      }),
      setLockedGroupPairActiveInTx: vi.fn().mockResolvedValue(true),
    };
    const groupMembership = {
      syncFromActiveInTx: vi
        .fn()
        .mockResolvedValue({ canonicalRosterChanged: true }),
    };
    const membershipFinalizer = {
      finalizeInTx: vi.fn().mockResolvedValue({
        audienceChanged: true,
        threadFanoutAdmitted: true,
      }),
    };
    const service = new GroupRelationshipFoldService(
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
      snapshot: null,
    });

    expect(
      relationshipIntents.setLockedGroupPairActiveInTx,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pairId: 1n, threadId: 3, active: false }),
    );
    expect(groupMembership.syncFromActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      {
        threadId: 3,
        groupId: 5,
        memberUserId: 7,
        active: false,
        pairChanged: true,
        hostedLocally: true,
      },
    );
  });

  it('runs the departure boundary effect after pair deactivation and before member removal', async () => {
    const relationshipIntents = {
      lockGroupMutationInTx: vi.fn().mockResolvedValue({
        id: 1n,
        endpointA: { type: 'GROUP', account: '!group', namespaceId: 0 },
        endpointB: { type: 'USER', account: 'alice', namespaceId: 0 },
        threadLock: {},
      }),
      setGroupPairActiveInTx: vi
        .fn()
        .mockResolvedValue({ changed: true, threadLock: {} }),
    };
    const groupMembership = {
      syncFromActiveInTx: vi
        .fn()
        .mockResolvedValue({ canonicalRosterChanged: true }),
    };
    const membershipFinalizer = {
      finalizeInTx: vi.fn().mockResolvedValue({
        audienceChanged: true,
        threadFanoutAdmitted: true,
      }),
    };
    const afterPairDeactivated = vi.fn().mockResolvedValue('boundary');
    const service = new GroupRelationshipFoldService(
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
      threadFanoutAdmitted: true,
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
      lockGroupMutationInTx: vi.fn().mockResolvedValue({
        id: 1n,
        endpointA: { type: 'GROUP', account: '!group', namespaceId: 0 },
        endpointB: { type: 'USER', account: 'alice', namespaceId: 0 },
        threadLock: {},
      }),
      setLockedGroupPairActiveInTx: vi.fn().mockResolvedValue(true),
    };
    const groupMembership = {
      syncFromActiveInTx: vi
        .fn()
        .mockResolvedValue({ canonicalRosterChanged: false }),
    };
    const membershipFinalizer = {
      finalizeInTx: vi.fn().mockResolvedValue({
        audienceChanged: false,
        threadFanoutAdmitted: false,
      }),
    };
    const service = new GroupRelationshipFoldService(
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

    expect(
      relationshipIntents.setLockedGroupPairActiveInTx,
    ).toHaveBeenCalledOnce();
    expect(groupMembership.syncFromActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      {
        threadId: 3,
        groupId: 5,
        memberUserId: 7,
        active: true,
        pairChanged: true,
        hostedLocally: false,
      },
    );
  });
});
