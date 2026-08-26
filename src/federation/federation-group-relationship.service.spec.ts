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
      writeAuthoredIntentInTx: vi.fn().mockResolvedValue({
        request,
        shouldBeActive: true,
        changed: true,
      }),
      setPairActiveInTx: vi.fn().mockResolvedValue(true),
    };
    const groupMembership = { syncFromActiveInTx: vi.fn() };
    const service = new FederationGroupRelationshipService(
      relationshipIntents as never,
      groupMembership as never,
    );

    const result = await service.writeAuthoredIntentInTx({} as never, {
      threadId: 3,
      groupUserId: 5,
      memberUserId: 7,
      authorUserId: 7,
      hostedLocally: true,
      status: 'ACCEPTED',
    });

    expect(relationshipIntents.setPairActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      5,
      7,
      true,
    );
    expect(groupMembership.syncFromActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      { threadId: 3, memberUserId: 7, active: true },
    );
    expect(result).toEqual(
      expect.objectContaining({ active: true, pairChanged: true }),
    );
  });

  it('forces a revoked authored intent inactive before deleting its member projection', async () => {
    const relationshipIntents = {
      writeAuthoredIntentInTx: vi.fn().mockResolvedValue({
        request: {
          status: 'REVOKED',
          note: '',
          requestedAt: null,
          expiresAt: null,
        },
        shouldBeActive: true,
        changed: true,
      }),
      setPairActiveInTx: vi.fn().mockResolvedValue(true),
    };
    const groupMembership = { syncFromActiveInTx: vi.fn() };
    const service = new FederationGroupRelationshipService(
      relationshipIntents as never,
      groupMembership as never,
    );

    await service.writeAuthoredIntentInTx({} as never, {
      threadId: 3,
      groupUserId: 5,
      memberUserId: 7,
      authorUserId: 5,
      hostedLocally: true,
      status: 'REVOKED',
    });

    expect(relationshipIntents.setPairActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      5,
      7,
      false,
    );
    expect(groupMembership.syncFromActiveInTx).toHaveBeenCalledWith(
      expect.anything(),
      { threadId: 3, memberUserId: 7, active: false },
    );
  });

  it('runs the departure boundary effect after pair deactivation and before member removal', async () => {
    const relationshipIntents = {
      setPairActiveInTx: vi.fn().mockResolvedValue(true),
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
      groupUserId: 5,
      memberUserId: 7,
      hostedLocally: true,
      afterPairDeactivated,
    });

    expect(result).toEqual({ pairChanged: true, effect: 'boundary' });
    expect(
      relationshipIntents.setPairActiveInTx.mock.invocationCallOrder[0],
    ).toBeLessThan(afterPairDeactivated.mock.invocationCallOrder[0]);
    expect(afterPairDeactivated.mock.invocationCallOrder[0]).toBeLessThan(
      groupMembership.syncFromActiveInTx.mock.invocationCallOrder[0],
    );
  });

  it('does not derive a member for a group hosted by another server', async () => {
    const relationshipIntents = {
      setPairActiveInTx: vi.fn().mockResolvedValue(true),
    };
    const groupMembership = { syncFromActiveInTx: vi.fn() };
    const service = new FederationGroupRelationshipService(
      relationshipIntents as never,
      groupMembership as never,
    );

    await service.syncActiveInTx({} as never, {
      threadId: 3,
      groupUserId: 5,
      memberUserId: 7,
      active: true,
      hostedLocally: false,
    });

    expect(relationshipIntents.setPairActiveInTx).toHaveBeenCalledOnce();
    expect(groupMembership.syncFromActiveInTx).not.toHaveBeenCalled();
  });
});
