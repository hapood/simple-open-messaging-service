import { describe, expect, it, vi } from 'vitest';
import { InviteController } from './invite.controller.js';

describe('InviteController.acceptInvite', () => {
  it('validates and queues a P2P invite without executing its mutation', async () => {
    const inviteService = {
      resolveAcceptInviteCommandScope: vi.fn().mockResolvedValue({
        kind: 'FRIEND',
        inviteId: '40',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'local' },
        ],
      }),
      acceptInvite: vi.fn(),
    };
    const domainCommands = {
      enqueue: vi.fn().mockResolvedValue({ commandId: 94n }),
    };
    const controller = new InviteController(
      {} as never,
      inviteService as never,
      {} as never,
      {} as never,
      {} as never,
      domainCommands as never,
    );

    await expect(
      controller.acceptInvite({ user: { userId: 7 } } as never, {
        inviteId: '40',
      }),
    ).resolves.toEqual({ commandId: '94', status: 'PENDING' });
    expect(inviteService.resolveAcceptInviteCommandScope).toHaveBeenCalledWith(
      '40',
      7,
    );
    expect(domainCommands.enqueue).toHaveBeenCalledWith({
      aggregate: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'local' },
        ],
      },
      commandType: 'ACCEPT_FRIEND_INVITE',
      actorUserId: 7,
      payload: { inviteId: '40' },
    });
    expect(inviteService.acceptInvite).not.toHaveBeenCalled();
  });

  it('validates and queues group invitation acceptance', async () => {
    const inviteService = {
      resolveAcceptInviteCommandScope: vi.fn().mockResolvedValue({
        kind: 'GROUP',
        inviteId: '50',
        threadId: 12,
        address: { account: '!group', domain: 'local' },
      }),
      acceptInvite: vi.fn(),
    };
    const federationService = { pushStateFeedDomains: vi.fn() };
    const clientStateFeed = { notifyFeedUpdates: vi.fn() };
    const domainCommands = {
      enqueue: vi.fn().mockResolvedValue({ commandId: 95n }),
    };
    const controller = new InviteController(
      {} as never,
      inviteService as never,
      {} as never,
      federationService as never,
      clientStateFeed as never,
      domainCommands as never,
    );

    await expect(
      controller.acceptInvite({ user: { userId: 7 } } as never, {
        inviteId: '50',
      }),
    ).resolves.toEqual({ commandId: '95', status: 'PENDING' });
    expect(domainCommands.enqueue).toHaveBeenCalledWith({
      aggregate: {
        type: 'GROUP',
        address: { account: '!group', domain: 'local' },
      },
      commandType: 'ACCEPT_GROUP_INVITATION',
      actorUserId: 7,
      payload: { threadId: 12 },
    });
    expect(inviteService.acceptInvite).not.toHaveBeenCalled();
  });
});

describe('InviteController.revokeInvite', () => {
  it('enqueues the local inviteId branch after validating author ownership', async () => {
    const inviteService = {
      resolveP2PInviteCommandScope: vi.fn().mockResolvedValue({
        inviteId: '42',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'local' },
        ],
      }),
      revokeInvite: vi.fn(),
    };
    const domainCommands = {
      enqueue: vi.fn().mockResolvedValue({ commandId: 93n }),
    };
    const controller = new InviteController(
      {} as never,
      inviteService as never,
      {} as never,
      {} as never,
      {} as never,
      domainCommands as never,
    );

    await expect(
      controller.revokeInvite({ user: { userId: 7 } } as never, {
        inviteId: '42',
      }),
    ).resolves.toEqual({ commandId: '93', status: 'PENDING' });
    expect(inviteService.resolveP2PInviteCommandScope).toHaveBeenCalledWith(
      '42',
      7,
      'AUTHOR',
    );
    expect(domainCommands.enqueue).toHaveBeenCalledWith({
      aggregate: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'local' },
        ],
      },
      commandType: 'REVOKE_FRIEND_INVITE',
      actorUserId: 7,
      payload: { inviteId: '42' },
    });
    expect(inviteService.revokeInvite).not.toHaveBeenCalled();
  });

  it('validates and queues an addressed federated revoke', async () => {
    const inviteService = {
      resolveFederatedFriendRequestCommandScope: vi.fn().mockResolvedValue({
        local: { account: 'alice', domain: 'local' },
        remote: { account: 'bob', domain: 'peer.test' },
      }),
    };
    const domainCommands = {
      enqueue: vi.fn().mockResolvedValue({ commandId: 96n }),
    };
    const controller = new InviteController(
      {} as never,
      inviteService as never,
      {} as never,
      {} as never,
      {} as never,
      domainCommands as never,
    );

    await expect(
      controller.revokeInvite({ user: { userId: 7 } } as never, {
        account: 'bob',
        domain: 'peer.test',
      }),
    ).resolves.toEqual({ commandId: '96', status: 'PENDING' });
    expect(domainCommands.enqueue).toHaveBeenCalledWith({
      aggregate: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'peer.test' },
        ],
      },
      commandType: 'REVOKE_ADDRESSED_FRIEND_REQUEST',
      actorUserId: 7,
      payload: { account: 'bob', domain: 'peer.test' },
    });
  });
});

describe('InviteController.sendFriendInvite', () => {
  it('returns durable command acceptance without executing the invite transaction', async () => {
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
    const inviteService = { createFriendInvite: vi.fn() };
    const domainCommands = {
      enqueue: vi.fn().mockResolvedValue({ commandId: 81n }),
    };
    const controller = new InviteController(
      userService as never,
      inviteService as never,
      {} as never,
      {} as never,
      {} as never,
      domainCommands as never,
    );

    await expect(
      controller.sendFriendInvite({ user: { userId: 7 } } as never, {
        account: ' Bob ',
        note: 'hello',
      }),
    ).resolves.toEqual({ commandId: '81', status: 'PENDING' });
    expect(domainCommands.enqueue).toHaveBeenCalledWith({
      aggregate: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'local' },
        ],
      },
      commandType: 'SEND_LOCAL_FRIEND_INVITE',
      actorUserId: 7,
      payload: { targetUserId: 9, note: 'hello' },
    });
    expect(inviteService.createFriendInvite).not.toHaveBeenCalled();
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
    const domainCommands = { enqueue: vi.fn() };
    const controller = new InviteController(
      userService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      domainCommands as never,
    );

    await expect(
      controller.sendFriendInvite({ user: { userId: 7 } } as never, {
        account: 'alice',
      }),
    ).rejects.toMatchObject({ bizCode: expectedCode });
    expect(domainCommands.enqueue).not.toHaveBeenCalled();
  });
});

describe('InviteController.rejectInvite', () => {
  it('validates and resolves the invite before enqueueing its pair command', async () => {
    const inviteService = {
      resolveP2PInviteCommandScope: vi.fn().mockResolvedValue({
        inviteId: '41',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'local' },
        ],
      }),
      rejectInvite: vi.fn(),
    };
    const domainCommands = {
      enqueue: vi.fn().mockResolvedValue({ commandId: 92n }),
    };
    const controller = new InviteController(
      {} as never,
      inviteService as never,
      {} as never,
      {} as never,
      {} as never,
      domainCommands as never,
    );

    await expect(
      controller.rejectInvite({ user: { userId: 7 } } as never, {
        inviteId: '41',
      }),
    ).resolves.toEqual({ commandId: '92', status: 'PENDING' });
    expect(inviteService.resolveP2PInviteCommandScope).toHaveBeenCalledWith(
      '41',
      7,
      'SUBJECT',
    );
    expect(domainCommands.enqueue).toHaveBeenCalledWith({
      aggregate: {
        type: 'USER_PAIR',
        endpoints: [
          { account: 'alice', domain: 'local' },
          { account: 'bob', domain: 'local' },
        ],
      },
      commandType: 'REJECT_FRIEND_INVITE',
      actorUserId: 7,
      payload: { inviteId: '41' },
    });
    expect(inviteService.rejectInvite).not.toHaveBeenCalled();
  });
});
