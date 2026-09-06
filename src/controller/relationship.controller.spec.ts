import { describe, expect, it, vi } from 'vitest';
import { RelationshipController } from './relationship.controller.js';

describe('RelationshipController.markRelationshipRequestsRead', () => {
  it('advances the relationship-request read watermark', async () => {
    const clientStateFeed = {
      markRelationshipRequestsRead: vi.fn().mockResolvedValue(42),
    };
    const controller = new RelationshipController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      clientStateFeed as never,
    );

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
    const controller = new RelationshipController(
      {} as never,
      {} as never,
      {} as never,
      federationService as never,
      durableTasks as never,
      {} as never,
    );

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

  it('validates and queues a local P2P request by Address', async () => {
    const relationshipService = {
      resolveP2PRequestCommandScope: vi.fn().mockResolvedValue({
        local: { account: 'alice', domain: 'local' },
        remote: { account: 'bob', domain: 'local' },
        peerUserId: 9,
      }),
      acceptRelationshipRequest: vi.fn(),
    };
    const durableTasks = {
      enqueueTask: vi.fn().mockResolvedValue({ taskId: 94n }),
    };
    const controller = new RelationshipController(
      {} as never,
      relationshipService as never,
      {} as never,
      {} as never,
      durableTasks as never,
      {} as never,
    );

    await expect(
      controller.acceptRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'local',
      }),
    ).resolves.toEqual({ taskId: '94', status: 'PENDING' });
    expect(
      relationshipService.resolveP2PRequestCommandScope,
    ).toHaveBeenCalledWith(7, 'bob', 'local', 'INCOMING');
    expect(durableTasks.enqueueTask).toHaveBeenCalledWith({
      scope: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'local' },
        ],
      },
      taskType: 'ACCEPT_RELATIONSHIP_REQUEST',
      actorUserId: 7,
      payload: { peerUserId: 9 },
    });
    expect(
      relationshipService.acceptRelationshipRequest,
    ).not.toHaveBeenCalled();
  });
});

describe('RelationshipController.revokeRelationship', () => {
  it('resolves and queues a local outgoing request by Address', async () => {
    const userService = {
      findUniqueUser: vi
        .fn()
        .mockResolvedValueOnce({ id: 7, account: 'alice', domain: 'local' })
        .mockResolvedValueOnce({ id: 9, account: 'bob', domain: 'local' }),
    };
    const relationshipService = {
      friendRelationshipStatuses: vi.fn().mockResolvedValue([
        {
          userId: 9,
          status: 'OUTGOING_PENDING',
        },
      ]),
      revokeRelationshipRequest: vi.fn(),
    };
    const participantService = {
      findP2PThreadBetween: vi.fn(),
    };
    const durableTasks = {
      enqueueTask: vi.fn().mockResolvedValue({ taskId: 93n }),
    };
    const controller = new RelationshipController(
      userService as never,
      relationshipService as never,
      participantService as never,
      {} as never,
      durableTasks as never,
      {} as never,
    );

    await expect(
      controller.revokeRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'local',
      }),
    ).resolves.toEqual({ taskId: '93', status: 'PENDING' });
    expect(relationshipService.friendRelationshipStatuses).toHaveBeenCalledWith(
      7,
      [9],
    );
    expect(durableTasks.enqueueTask).toHaveBeenCalledWith({
      scope: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'local' },
        ],
      },
      taskType: 'REVOKE_RELATIONSHIP_REQUEST',
      actorUserId: 7,
      payload: { peerUserId: 9 },
    });
    expect(participantService.findP2PThreadBetween).not.toHaveBeenCalled();
    expect(
      relationshipService.revokeRelationshipRequest,
    ).not.toHaveBeenCalled();
  });

  it('resolves and queues a local incoming request by Address', async () => {
    const userService = {
      findUniqueUser: vi
        .fn()
        .mockResolvedValueOnce({ id: 7, account: 'alice', domain: 'local' })
        .mockResolvedValueOnce({ id: 9, account: 'bob', domain: 'local' }),
    };
    const relationshipService = {
      friendRelationshipStatuses: vi.fn().mockResolvedValue([
        {
          userId: 9,
          status: 'INCOMING_PENDING',
        },
      ]),
    };
    const participantService = { findP2PThreadBetween: vi.fn() };
    const durableTasks = {
      enqueueTask: vi.fn().mockResolvedValue({ taskId: 94n }),
    };
    const controller = new RelationshipController(
      userService as never,
      relationshipService as never,
      participantService as never,
      {} as never,
      durableTasks as never,
      {} as never,
    );

    await expect(
      controller.revokeRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'local',
      }),
    ).resolves.toEqual({ taskId: '94', status: 'PENDING' });
    expect(durableTasks.enqueueTask).toHaveBeenCalledWith({
      scope: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'local' },
        ],
      },
      taskType: 'REJECT_RELATIONSHIP_REQUEST',
      actorUserId: 7,
      payload: { peerUserId: 9 },
    });
    expect(participantService.findP2PThreadBetween).not.toHaveBeenCalled();
  });

  it('queues an active local friendship end by Address', async () => {
    const userService = {
      findUniqueUser: vi
        .fn()
        .mockResolvedValueOnce({ id: 7, account: 'alice', domain: 'local' })
        .mockResolvedValueOnce({ id: 9, account: 'bob', domain: 'local' }),
    };
    const inviteService = {
      friendRelationshipStatuses: vi
        .fn()
        .mockResolvedValue([{ userId: 9, status: 'FRIEND' }]),
    };
    const participantService = {
      findP2PThreadBetween: vi.fn().mockResolvedValue(12),
      endP2P: vi.fn(),
    };
    const durableTasks = {
      enqueueTask: vi.fn().mockResolvedValue({ taskId: 95n }),
    };
    const controller = new RelationshipController(
      userService as never,
      inviteService as never,
      participantService as never,
      {} as never,
      durableTasks as never,
      {} as never,
    );

    await expect(
      controller.revokeRelationship({ user: { userId: 7 } } as never, {
        account: ' Bob ',
        domain: 'local',
      }),
    ).resolves.toEqual({ taskId: '95', status: 'PENDING' });
    expect(inviteService.friendRelationshipStatuses).toHaveBeenCalledWith(7, [
      9,
    ]);
    expect(participantService.findP2PThreadBetween).toHaveBeenCalledWith(7, 9);
    expect(durableTasks.enqueueTask).toHaveBeenCalledWith({
      scope: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'local' },
        ],
      },
      taskType: 'END_FRIENDSHIP',
      actorUserId: 7,
      payload: { threadId: 12 },
    });
    expect(participantService.endP2P).not.toHaveBeenCalled();
  });

  it('validates and queues an addressed federated revoke', async () => {
    const userService = {
      findUniqueUser: vi
        .fn()
        .mockResolvedValueOnce({ id: 7, account: 'alice', domain: 'local' })
        .mockResolvedValueOnce(null),
    };
    const inviteService = {
      federatedRelationshipContext: vi
        .fn()
        .mockResolvedValue({ namespaceId: 2, status: 'OUTGOING_PENDING' }),
    };
    const durableTasks = {
      enqueueTask: vi.fn().mockResolvedValue({ taskId: 93n }),
    };
    const controller = new RelationshipController(
      userService as never,
      inviteService as never,
      {} as never,
      {} as never,
      durableTasks as never,
      {} as never,
    );

    await expect(
      controller.revokeRelationship({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'peer.test',
      }),
    ).resolves.toEqual({ taskId: '93', status: 'PENDING' });
    expect(inviteService.federatedRelationshipContext).toHaveBeenCalledWith(
      7,
      'bob',
      'peer.test',
    );
    expect(userService.findUniqueUser).toHaveBeenCalledWith({
      account_domain: { account: 'bob', domain: 'peer.test' },
      namespaceId: 2,
    });
    expect(durableTasks.enqueueTask).toHaveBeenCalledWith({
      scope: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'peer.test' },
        ],
      },
      taskType: 'REVOKE_ADDRESSED_RELATIONSHIP_REQUEST',
      actorUserId: 7,
      payload: { account: 'bob', domain: 'peer.test' },
    });
  });
});

describe('RelationshipController.requestRelationship', () => {
  it('returns durable task acceptance without executing the relationship transaction', async () => {
    const userService = {
      findUniqueUser: vi
        .fn()
        .mockResolvedValueOnce({
          id: 7,
          account: 'alice',
          domain: 'local',
          availability: 'AVAILABLE',
        })
        .mockResolvedValueOnce({
          id: 9,
          account: 'bob',
          domain: 'local',
          availability: 'AVAILABLE',
        }),
    };
    const relationshipService = { createRelationshipRequest: vi.fn() };
    const durableTasks = {
      enqueueTask: vi.fn().mockResolvedValue({ taskId: 81n }),
    };
    const controller = new RelationshipController(
      userService as never,
      relationshipService as never,
      {} as never,
      {} as never,
      durableTasks as never,
      {} as never,
    );

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: ' Bob ',
        domain: 'local',
        note: 'hello',
      }),
    ).resolves.toEqual({ taskId: '81', status: 'PENDING' });
    expect(durableTasks.enqueueTask).toHaveBeenCalledWith({
      scope: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'local' },
        ],
      },
      taskType: 'SEND_LOCAL_RELATIONSHIP_REQUEST',
      actorUserId: 7,
      payload: { targetUserId: 9, note: 'hello' },
    });
    expect(
      relationshipService.createRelationshipRequest,
    ).not.toHaveBeenCalled();
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
  ])('rejects $name before enqueue', async ({ target, expectedCode }) => {
    const userService = {
      findUniqueUser: vi
        .fn()
        .mockResolvedValueOnce({
          id: 7,
          account: 'alice',
          domain: 'local',
          availability: 'AVAILABLE',
        })
        .mockResolvedValueOnce(target),
    };
    const durableTasks = { enqueueTask: vi.fn() };
    const controller = new RelationshipController(
      userService as never,
      {} as never,
      {} as never,
      {} as never,
      durableTasks as never,
      {} as never,
    );

    await expect(
      controller.requestRelationship({ user: { userId: 7 } } as never, {
        account: 'alice',
        domain: 'local',
      }),
    ).rejects.toMatchObject({ bizCode: expectedCode });
    expect(durableTasks.enqueueTask).not.toHaveBeenCalled();
  });
});
