import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { RelationshipController } from './relationship.controller.js';

/** Constructor order: userService, relationships, federation, durableTasks,
 * clientStateFeed, userIntents, userQuota. */
function build(overrides: {
  userService?: unknown;
  relationships?: unknown;
  federation?: unknown;
  durableTasks?: unknown;
  clientStateFeed?: unknown;
  userIntents?: unknown;
  userQuota?: unknown;
}): RelationshipController {
  return new RelationshipController(
    (overrides.userService ?? {}) as never,
    (overrides.relationships ?? {}) as never,
    (overrides.federation ?? {}) as never,
    (overrides.durableTasks ?? {}) as never,
    (overrides.clientStateFeed ?? {}) as never,
    (overrides.userIntents ?? {}) as never,
    (overrides.userQuota ?? {}) as never,
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
    const federationService = {
      resolveAddressedGroupInvitationCommandScope: vi.fn().mockResolvedValue({
        account: '!remote-group',
        domain: 'peer.test',
      }),
    };
    const durableTasks = {
      enqueueTask: vi.fn().mockResolvedValue({ taskId: 93n }),
    };
    const controller = build({ federation: federationService, durableTasks });

    await expect(
      controller.acceptRelationship({ user: { userId: 7 } } as never, {
        account: '!remote-group',
        domain: 'peer.test',
      }),
    ).resolves.toEqual({ taskId: '93', status: 'PENDING' });
    expect(
      federationService.resolveAddressedGroupInvitationCommandScope,
    ).toHaveBeenCalledWith(7, {
      account: '!remote-group',
      domain: 'peer.test',
    });
    expect(durableTasks.enqueueTask).toHaveBeenCalledWith({
      scope: {
        type: 'GROUP',
        address: { account: '!remote-group', domain: 'peer.test' },
      },
      taskType: 'ACCEPT_ADDRESSED_GROUP_INVITATION',
      actorUserId: 7,
      payload: { account: '!remote-group', domain: 'peer.test' },
    });
  });

  it('activates a known local P2P request synchronously through the intent service', async () => {
    const relationships = {
      resolveP2PRequestCommandScope: vi.fn().mockResolvedValue({
        local: { account: 'alice', domain: 'local' },
        remote: { account: 'bob', domain: 'local' },
        peerUserId: 9,
      }),
    };
    const userIntents = {
      execute: vi.fn().mockResolvedValue({ threadId: 12 }),
    };
    const controller = build({ relationships, userIntents });

    await expect(
      controller.acceptRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'local',
      }),
    ).resolves.toEqual({ status: 'OK', threadId: 12 });
    expect(relationships.resolveP2PRequestCommandScope).toHaveBeenCalledWith(
      7,
      'bob',
      'local',
      'INCOMING',
    );
    expect(userIntents.execute).toHaveBeenCalledWith({
      userId: 7,
      decision: 'ACCEPTED',
      target: { account: 'bob', domain: 'local' },
    });
  });

  it('keeps the addressed remote acceptance durable-task based', async () => {
    const relationships = {
      resolveP2PRequestCommandScope: vi.fn().mockResolvedValue({
        local: { account: 'alice', domain: 'local' },
        remote: { account: 'bob', domain: 'peer.test' },
        peerUserId: null,
      }),
    };
    const durableTasks = {
      enqueueTask: vi.fn().mockResolvedValue({ taskId: 95n }),
    };
    const controller = build({ relationships, durableTasks });

    await expect(
      controller.acceptRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'peer.test',
      }),
    ).resolves.toEqual({ taskId: '95', status: 'PENDING' });
    expect(durableTasks.enqueueTask).toHaveBeenCalledWith({
      scope: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'peer.test' },
        ],
      },
      taskType: 'ACCEPT_ADDRESSED_RELATIONSHIP_REQUEST',
      actorUserId: 7,
      payload: { account: 'bob', domain: 'peer.test' },
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

  it('maps the stale-revocation NOT_FOUND onto the legacy FRIEND_NOT_FOUND code', async () => {
    const userIntents = {
      execute: vi
        .fn()
        .mockRejectedValue(
          new BusinessException(BusinessCode.NOT_FOUND, 'request not found'),
        ),
    };
    const controller = build({ userIntents });

    await expect(
      controller.revokeRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'local',
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FRIEND_NOT_FOUND });
  });

  it('keeps the addressed group revocation durable-task based', async () => {
    const federationService = {
      resolveGroupJoinRequestCommandScope: vi
        .fn()
        .mockResolvedValue({ account: '!remote-group', domain: 'peer.test' }),
    };
    const durableTasks = {
      enqueueTask: vi.fn().mockResolvedValue({ taskId: 96n }),
    };
    const controller = build({ federation: federationService, durableTasks });

    await expect(
      controller.revokeRelationship({ user: { userId: 7 } } as never, {
        account: '!remote-group',
        domain: 'peer.test',
      }),
    ).resolves.toEqual({ taskId: '96', status: 'PENDING' });
    expect(durableTasks.enqueueTask).toHaveBeenCalledWith({
      scope: {
        type: 'GROUP',
        address: { account: '!remote-group', domain: 'peer.test' },
      },
      taskType: 'REVOKE_USER_RELATIONSHIP',
      actorUserId: 7,
      payload: { account: '!remote-group', domain: 'peer.test' },
    });
  });
});

describe('RelationshipController.requestRelationship', () => {
  it('runs the local request synchronously with in-transaction quota admission', async () => {
    const userService = {
      findRelationshipAdmissionAccounts: vi.fn().mockResolvedValue([
        {
          id: 7,
          account: 'alice',
          domain: 'local',
          availability: 'AVAILABLE',
          disabledAt: null,
        },
        {
          id: 9,
          account: 'bob',
          domain: 'local',
          availability: 'AVAILABLE',
          disabledAt: null,
        },
      ]),
    };
    const userQuota = { tick: vi.fn().mockResolvedValue(undefined) };
    const admissionTx = { admission: true };
    const userIntents = {
      execute: vi.fn().mockImplementation(async (_params, options) => {
        await options?.admissionInTx?.(admissionTx);
        return {};
      }),
    };
    const controller = build({ userService, userIntents, userQuota });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: ' Bob ',
        domain: 'local',
        note: 'hello',
      }),
    ).resolves.toEqual({ status: 'OK' });
    expect(userService.findRelationshipAdmissionAccounts).toHaveBeenCalledWith(
      7,
      'bob',
    );
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
    const userService = {
      findRelationshipAdmissionAccounts: vi.fn().mockResolvedValue([
        {
          id: 7,
          account: 'alice',
          domain: 'local',
          availability: 'AVAILABLE',
          disabledAt: null,
        },
        {
          id: 9,
          account: 'bob',
          domain: 'local',
          availability: 'AVAILABLE',
          disabledAt: null,
        },
      ]),
    };
    const userIntents = {
      execute: vi.fn().mockResolvedValue({ threadId: 33 }),
    };
    const controller = build({ userService, userIntents });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'local',
      }),
    ).resolves.toEqual({ status: 'OK', threadId: 33 });
  });

  it('keeps the federated request durable-task based', async () => {
    const userService = {
      findUniqueUser: vi.fn().mockResolvedValue({
        id: 7,
        account: 'alice',
        domain: 'local',
        availability: 'AVAILABLE',
      }),
    };
    const federationService = { ourDomain: 'us.test' };
    const durableTasks = {
      enqueueTask: vi.fn().mockResolvedValue({ taskId: 82n }),
    };
    const controller = build({
      userService,
      federationService,
      durableTasks,
    });

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'peer.test',
        displayName: 'Bob',
      }),
    ).resolves.toEqual({ taskId: '82', status: 'PENDING' });
    expect(durableTasks.enqueueTask).toHaveBeenCalledWith({
      scope: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'peer.test' },
        ],
      },
      taskType: 'SEND_FEDERATED_RELATIONSHIP_REQUEST',
      actorUserId: 7,
      payload: {
        account: 'bob',
        domain: 'peer.test',
        note: '',
        displayName: 'Bob',
      },
    });
  });

  it.each([
    {
      name: 'missing target',
      target: null,
      expectedCode: 10001,
    },
    {
      name: 'self target',
      target: {
        id: 7,
        account: 'alice',
        domain: 'local',
        availability: 'AVAILABLE',
      },
      expectedCode: 20001,
    },
  ])(
    'rejects $name before the intent runs',
    async ({ target, expectedCode }) => {
      const userService = {
        findRelationshipAdmissionAccounts: vi.fn().mockResolvedValue(
          target === null
            ? [
                {
                  id: 7,
                  account: 'alice',
                  domain: 'local',
                  availability: 'AVAILABLE',
                  disabledAt: null,
                },
              ]
            : [target],
        ),
      };
      const userIntents = { execute: vi.fn() };
      const controller = build({ userService, userIntents });

      await expect(
        controller.requestRelationship({ user: { userId: 7 } } as never, {
          account: target === null ? 'bob' : 'alice',
          domain: 'local',
        }),
      ).rejects.toMatchObject({ bizCode: expectedCode });
      expect(userIntents.execute).not.toHaveBeenCalled();
    },
  );
});
