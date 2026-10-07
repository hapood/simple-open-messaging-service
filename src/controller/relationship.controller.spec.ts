import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { RelationshipController } from './relationship.controller.js';

/** Constructor order: clientStateFeed, userIntents, userQuota, memberIntents. */
function build(overrides: {
  clientStateFeed?: unknown;
  userIntents?: unknown;
  userQuota?: unknown;
  memberIntents?: unknown;
}): RelationshipController {
  return new RelationshipController(
    (overrides.clientStateFeed ?? {}) as never,
    (overrides.userIntents ?? {}) as never,
    (overrides.userQuota ?? {}) as never,
    (overrides.memberIntents ?? {}) as never,
  );
}

describe('RelationshipController.markRelationshipRequestsRead', () => {
  it('advances the relationship-request read watermark', async () => {
    const clientStateFeed = {
      markRelationshipRequestsRead: vi.fn().mockResolvedValue(42),
    };
    const controller = build({ clientStateFeed });

    await expect(
      controller.markRelationshipRequestsRead(
        { user: { userId: 7 } } as never,
        { readThroughFeedId: 41 },
      ),
    ).resolves.toEqual({ readThroughFeedId: 42 });
    expect(clientStateFeed.markRelationshipRequestsRead).toHaveBeenCalledWith(
      7,
      41,
    );
  });
});

describe('RelationshipController.acceptRelationship', () => {
  it('resolves an addressed group invitation from its relationship intent', async () => {
    const memberIntents = {
      executeAddressed: vi.fn().mockResolvedValue({ status: 'APPLIED' }),
    };
    const controller = build({ memberIntents });

    await expect(
      controller.acceptRelationship({ user: { userId: 7 } } as never, {
        account: '!remote-group',
        domain: 'peer.test',
      }),
    ).resolves.toEqual({ status: 'APPLIED' });
    expect(memberIntents.executeAddressed).toHaveBeenCalledWith({
      memberUserId: 7,
      target: { account: '!remote-group', domain: 'peer.test' },
      decision: 'ACCEPTED',
    });
  });

  it('activates a known local P2P request synchronously through the intent service', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({
        status: 'APPLIED',
        threadId: 12,
      }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.acceptRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'local',
      }),
    ).resolves.toEqual({ status: 'OK', threadId: 12 });
    expect(userIntents.execute).toHaveBeenCalledWith({
      userId: 7,
      decision: 'ACCEPTED',
      target: { account: 'bob', domain: 'local' },
    });
  });

  it('accepts an address-only remote request synchronously through the intent service', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({
        status: 'APPLIED',
        threadId: 21,
      }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.acceptRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'peer.test',
      }),
    ).resolves.toEqual({ status: 'OK', threadId: 21 });
    expect(userIntents.execute).toHaveBeenCalledWith({
      userId: 7,
      decision: 'ACCEPTED',
      target: { account: 'bob', domain: 'peer.test' },
    });
  });

  it('preserves the invite-specific API code for a missing P2P intent', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({
        status: 'REJECTED',
        reason: 'INTENT_NOT_FOUND',
        code: BusinessCode.NOT_FOUND,
        message: 'request not found',
      }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.acceptRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'local',
      }),
    ).resolves.toMatchObject({
      code: BusinessCode.INVITE_NOT_FOUND,
      data: { status: 'REJECTED', reason: 'INTENT_NOT_FOUND' },
    });
  });

  it('forwards a namespace id on acceptance for nsid-first addressing', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({ status: 'APPLIED', threadId: 21 }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.acceptRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'peer.test',
        namespaceId: 5,
      }),
    ).resolves.toEqual({ status: 'OK', threadId: 21 });
    expect(userIntents.execute).toHaveBeenCalledWith({
      userId: 7,
      decision: 'ACCEPTED',
      target: { account: 'bob', domain: 'peer.test', namespaceId: 5 },
    });
  });
});

describe('RelationshipController.revokeRelationship', () => {
  it('revokes a local relationship synchronously through the intent service', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({}),
    };
    const controller = build({ userIntents });

    await expect(
      controller.revokeRelationship({ user: { userId: 7 } } as never, {
        account: ' Bob ',
        domain: 'local',
      }),
    ).resolves.toEqual({ status: 'OK' });
    expect(userIntents.execute).toHaveBeenCalledWith({
      userId: 7,
      decision: 'REVOKED',
      target: { account: 'bob', domain: 'local' },
    });
  });

  it('revokes a federated relationship by address through the intent service', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({}),
    };
    const controller = build({ userIntents });

    await expect(
      controller.revokeRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'peer.test',
      }),
    ).resolves.toEqual({ status: 'OK' });
    expect(userIntents.execute).toHaveBeenCalledWith({
      userId: 7,
      decision: 'REVOKED',
      target: { account: 'bob', domain: 'peer.test' },
    });
  });

  it('maps stale-revocation NOT_FOUND onto the public FRIEND_NOT_FOUND code', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({
        status: 'REJECTED',
        reason: 'INTENT_NOT_FOUND',
        code: BusinessCode.NOT_FOUND,
        message: 'request not found',
      }),
    };
    const controller = build({ userIntents });

    const result = await controller.revokeRelationship(
      { user: { userId: 7 } } as never,
      {
        account: 'bob',
        domain: 'local',
      },
    );
    expect(result).toMatchObject({
      code: BusinessCode.FRIEND_NOT_FOUND,
      data: { status: 'REJECTED', reason: 'INTENT_NOT_FOUND' },
    });
  });

  it('revokes an addressed group application synchronously', async () => {
    const memberIntents = {
      executeAddressed: vi.fn().mockResolvedValue({ status: 'APPLIED' }),
    };
    const controller = build({ memberIntents });

    await expect(
      controller.revokeRelationship({ user: { userId: 7 } } as never, {
        account: '!remote-group',
        domain: 'peer.test',
      }),
    ).resolves.toEqual({ status: 'APPLIED' });
    expect(memberIntents.executeAddressed).toHaveBeenCalledWith({
      memberUserId: 7,
      target: { account: '!remote-group', domain: 'peer.test' },
      decision: 'REVOKED',
    });
  });
});

describe('RelationshipController.requestRelationship', () => {
  it('authors an exact local-group application with quota admission', async () => {
    const memberIntents = {
      executeAddressed: vi.fn().mockResolvedValue({ status: 'APPLIED' }),
    };
    const controller = build({
      userQuota: { tick: vi.fn() },
      memberIntents,
    });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: '!local-group',
        domain: 'local',
        note: 'hello',
      }),
    ).resolves.toEqual({ status: 'APPLIED' });
    expect(memberIntents.executeAddressed).toHaveBeenCalledWith({
      memberUserId: 7,
      target: { account: '!local-group', domain: 'local' },
      decision: 'REQUESTED',
      note: 'hello',
      snapshot: { displayName: undefined },
      admissionInTx: expect.any(Function),
    });
  });

  it('authors an addressed remote-group application directly', async () => {
    const admissionTx = { admission: true };
    const userQuota = { tick: vi.fn().mockResolvedValue(undefined) };
    const memberIntents = {
      executeAddressed: vi.fn().mockImplementation(async (params) => {
        await params.admissionInTx(admissionTx);
        return { status: 'APPLIED' };
      }),
    };
    const controller = build({
      userQuota,
      memberIntents,
    });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: '!remote-group',
        domain: 'peer.test',
        displayName: 'Remote Group',
        avatar: 'avatar',
        note: 'let me in',
      }),
    ).resolves.toEqual({ status: 'APPLIED' });
    expect(memberIntents.executeAddressed).toHaveBeenCalledWith({
      memberUserId: 7,
      target: { account: '!remote-group', domain: 'peer.test' },
      decision: 'REQUESTED',
      note: 'let me in',
      snapshot: { displayName: 'Remote Group', avatar: 'avatar' },
      admissionInTx: expect.any(Function),
    });
    expect(userQuota.tick).toHaveBeenCalledWith(7, 'requests', admissionTx);
  });

  it('runs the local request synchronously with in-transaction quota admission', async () => {
    const userQuota = { tick: vi.fn().mockResolvedValue(undefined) };
    const admissionTx = { admission: true };
    const userIntents = {
      execute: vi.fn().mockImplementation(async (_params, options) => {
        await options?.admissionInTx?.(admissionTx);
        return { status: 'APPLIED' };
      }),
    };
    const controller = build({ userIntents, userQuota });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: ' Bob ',
        domain: 'local',
        note: 'hello',
      }),
    ).resolves.toEqual({ status: 'OK' });
    expect(userIntents.execute).toHaveBeenCalledWith(
      {
        userId: 7,
        decision: 'REQUESTED',
        target: { account: 'bob', domain: 'local' },
        note: 'hello',
      },
      expect.objectContaining({ admissionInTx: expect.any(Function) }),
    );
    expect(userQuota.tick).toHaveBeenCalledWith(7, 'requests', admissionTx);
  });

  it('returns the active thread when the request collapses into acceptance', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({
        status: 'APPLIED',
        threadId: 33,
      }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'local',
      }),
    ).resolves.toEqual({ status: 'OK', threadId: 33 });
  });

  it('runs the addressed request synchronously with in-transaction quota admission', async () => {
    const userQuota = { tick: vi.fn().mockResolvedValue(undefined) };
    const admissionTx = { admission: true };
    const userIntents = {
      execute: vi.fn().mockImplementation(async (_params, options) => {
        await options?.admissionInTx?.(admissionTx);
        return { status: 'APPLIED' };
      }),
    };
    const controller = build({
      userIntents,
      userQuota,
    });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'peer.test',
        displayName: 'Bob',
        note: 'across servers',
      }),
    ).resolves.toEqual({ status: 'OK' });
    expect(userIntents.execute).toHaveBeenCalledWith(
      {
        userId: 7,
        decision: 'REQUESTED',
        target: { account: 'bob', domain: 'peer.test' },
        note: 'across servers',
      },
      expect.objectContaining({ admissionInTx: expect.any(Function) }),
    );
    expect(userQuota.tick).toHaveBeenCalledWith(7, 'requests', admissionTx);
  });

  it('keeps the local public domain as an addressed remote target', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({ status: 'APPLIED' }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'us.test',
        displayName: 'Bob',
      }),
    ).resolves.toEqual({ status: 'OK' });
    expect(userIntents.execute).toHaveBeenCalledWith(
      {
        userId: 7,
        decision: 'REQUESTED',
        target: { account: 'bob', domain: 'us.test' },
        note: '',
      },
      expect.objectContaining({ admissionInTx: expect.any(Function) }),
    );
  });

  it('returns an unavailable actor as a business rejection', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({
        status: 'REJECTED',
        reason: 'ACTOR_NOT_FOUND',
        code: BusinessCode.UNAUTHENTICATED,
        message: 'authenticated user does not exist',
      }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'peer.test',
        displayName: 'Bob',
      }),
    ).resolves.toMatchObject({
      code: BusinessCode.UNAUTHENTICATED,
      data: { status: 'REJECTED', reason: 'ACTOR_NOT_FOUND' },
    });
  });

  it('forwards a namespace id from the DTO to the intent service for nsid-first addressing', async () => {
    const userIntents = {
      execute: vi.fn().mockResolvedValue({ status: 'APPLIED', threadId: 42 }),
    };
    const controller = build({ userIntents });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'peer.test',
        namespaceId: 5,
        displayName: 'Bob',
        note: 'nsid-first',
      }),
    ).resolves.toEqual({ status: 'OK', threadId: 42 });
    expect(userIntents.execute).toHaveBeenCalledWith(
      {
        userId: 7,
        decision: 'REQUESTED',
        target: { account: 'bob', domain: 'peer.test', namespaceId: 5 },
        note: 'nsid-first',
      },
      expect.objectContaining({ admissionInTx: expect.any(Function) }),
    );
  });

  it.each([
    {
      name: 'missing target',
      reason: 'TARGET_NOT_FOUND',
      expectedCode: BusinessCode.NOT_FOUND,
    },
    {
      name: 'self target',
      reason: 'SELF_TARGET',
      expectedCode: BusinessCode.FRIEND_SELF,
    },
  ])(
    'serializes $name returned by the intent service',
    async ({ reason, expectedCode }) => {
      const userIntents = {
        execute: vi.fn().mockResolvedValue({
          status: 'REJECTED',
          reason,
          code: expectedCode,
          message: 'business rejection',
        }),
      };
      const controller = build({ userIntents });

      await expect(
        controller.requestRelationship({ user: { userId: 7 } } as never, {
          account: reason === 'SELF_TARGET' ? 'alice' : 'bob',
          domain: 'local',
        }),
      ).resolves.toMatchObject({
        code: expectedCode,
        data: { status: 'REJECTED', reason },
      });
    },
  );
});
