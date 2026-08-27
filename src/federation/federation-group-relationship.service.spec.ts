import { describe, expect, it, vi } from 'vitest';
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
      writeGroupAuthoredIntentInTx: vi.fn().mockResolvedValue({
        request,
        shouldBeActive: true,
        changed: true,
      }),
      setGroupPairActiveInTx: vi.fn().mockResolvedValue(true),
    };
    const groupMembership = { syncFromActiveInTx: vi.fn() };
    const service = new FederationGroupRelationshipService(
      relationshipIntents as never,
      groupMembership as never,
    );

    const result = await service.writeAuthoredIntentInTx({} as never, {
      threadId: 3,
      groupId: 5,
      memberUserId: 7,
      author: 'MEMBER',
      hostedLocally: true,
      status: 'ACCEPTED',
    });

    expect(relationshipIntents.setGroupPairActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      { groupId: 5, memberUserId: 7, threadId: 3, active: true },
    );
    expect(groupMembership.syncFromActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      { threadId: 3, memberUserId: 7, active: true, hostedLocally: true },
    );
    expect(result).toEqual(
      expect.objectContaining({ active: true, pairChanged: true }),
    );
  });

  it('forces a revoked authored intent inactive before deleting its member projection', async () => {
    const relationshipIntents = {
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
    const groupMembership = { syncFromActiveInTx: vi.fn() };
    const service = new FederationGroupRelationshipService(
      relationshipIntents as never,
      groupMembership as never,
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
      { threadId: 3, memberUserId: 7, active: false, hostedLocally: true },
    );
  });

  it('runs the departure boundary effect after pair deactivation and before member removal', async () => {
    const relationshipIntents = {
      setGroupPairActiveInTx: vi.fn().mockResolvedValue(true),
    };
    const groupMembership = {
      syncFromActiveInTx: vi.fn().mockResolvedValue(undefined),
    };
    const afterPairDeactivated = vi.fn().mockResolvedValue('boundary');
    const service = new FederationGroupRelationshipService(
      relationshipIntents as never,
      groupMembership as never,
    );

    const result = await service.deactivateAfterInTx({} as never, {
      threadId: 3,
      groupId: 5,
      memberUserId: 7,
      hostedLocally: true,
      afterPairDeactivated,
    });

    expect(result).toEqual({ pairChanged: true, effect: 'boundary' });
    expect(
      relationshipIntents.setGroupPairActiveInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(afterPairDeactivated.mock.invocationCallOrder[0]);
    expect(afterPairDeactivated.mock.invocationCallOrder[0]).toBeLessThan(
      groupMembership.syncFromActiveInTx.mock.invocationCallOrder[0],
    );
  });

  it('does not derive a member for a group hosted by another server', async () => {
    const relationshipIntents = {
      setGroupPairActiveInTx: vi.fn().mockResolvedValue(true),
    };
    const groupMembership = { syncFromActiveInTx: vi.fn() };
    const service = new FederationGroupRelationshipService(
      relationshipIntents as never,
      groupMembership as never,
    );

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
        memberUserId: 7,
        active: true,
        hostedLocally: false,
      },
    );
  });
});
