import { describe, expect, it, vi } from 'vitest';
import type { DomainCommand } from '../domain-command/domain-command.types.js';
import {
  AcceptAddressedFriendRequestCommandHandler,
  RevokeAddressedFriendRequestCommandHandler,
  SendFederatedFriendInviteCommandHandler,
} from './federated-friend-command.handlers.js';
import {
  AcceptAddressedGroupInvitationCommandHandler,
  RequestFederatedGroupJoinCommandHandler,
  RevokeFederatedGroupJoinCommandHandler,
} from './federated-group-command.handlers.js';

function command(
  aggregateType: 'USER_PAIR' | 'GROUP',
  payload: Record<string, unknown>,
): DomainCommand {
  return {
    id: 1n,
    parentCommandId: null,
    aggregateType,
    aggregateKey: 'scope',
    commandType: 'TEST',
    actorUserId: 7,
    payload,
    progressCursor: null,
    status: 'PROCESSING',
    resultCode: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  };
}

describe('federated command handlers', () => {
  const dispatcher = { register: vi.fn() };

  it('dispatches addressed friend commands with normalized persisted input', async () => {
    const execution = {
      send: vi.fn().mockResolvedValue(undefined),
      accept: vi.fn().mockResolvedValue(undefined),
      revoke: vi.fn().mockResolvedValue(undefined),
    };
    await new SendFederatedFriendInviteCommandHandler(
      dispatcher as never,
      execution as never,
    ).execute(
      command('USER_PAIR', {
        account: 'bob',
        domain: 'peer.test',
        note: 'hello',
        displayName: 'Bob',
      }),
    );
    await new AcceptAddressedFriendRequestCommandHandler(
      dispatcher as never,
      execution as never,
    ).execute(command('USER_PAIR', { account: 'bob', domain: 'peer.test' }));
    await new RevokeAddressedFriendRequestCommandHandler(
      dispatcher as never,
      execution as never,
    ).execute(command('USER_PAIR', { account: 'bob', domain: 'peer.test' }));

    expect(execution.send).toHaveBeenCalledWith({
      actorUserId: 7,
      account: 'bob',
      domain: 'peer.test',
      note: 'hello',
      displayName: 'Bob',
    });
    expect(execution.accept).toHaveBeenCalledWith({
      actorUserId: 7,
      account: 'bob',
      domain: 'peer.test',
    });
    expect(execution.revoke).toHaveBeenCalledWith({
      actorUserId: 7,
      account: 'bob',
      domain: 'peer.test',
    });
  });

  it('dispatches federated group request, revoke, and acceptance commands', async () => {
    const execution = {
      request: vi.fn().mockResolvedValue(undefined),
      revoke: vi.fn().mockResolvedValue(undefined),
      accept: vi.fn().mockResolvedValue(undefined),
    };
    await new RequestFederatedGroupJoinCommandHandler(
      dispatcher as never,
      execution as never,
    ).execute(
      command('GROUP', {
        account: '!group',
        domain: 'peer.test',
        note: 'join',
        displayName: 'Group',
      }),
    );
    await new RevokeFederatedGroupJoinCommandHandler(
      dispatcher as never,
      execution as never,
    ).execute(command('GROUP', { account: '!group', domain: 'peer.test' }));
    await new AcceptAddressedGroupInvitationCommandHandler(
      dispatcher as never,
      execution as never,
    ).execute(command('GROUP', { account: '!group', domain: 'peer.test' }));

    expect(execution.request).toHaveBeenCalledWith({
      actorUserId: 7,
      account: '!group',
      domain: 'peer.test',
      note: 'join',
      displayName: 'Group',
    });
    expect(execution.revoke).toHaveBeenCalled();
    expect(execution.accept).toHaveBeenCalled();
  });
});
