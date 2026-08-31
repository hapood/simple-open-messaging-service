import { describe, expect, it, vi } from 'vitest';
import { DomainCommandDispatcherService } from '../domain-command/domain-command-dispatcher.service.js';
import type { DomainCommand } from '../domain-command/domain-command.types.js';
import { AcceptFriendInviteCommandHandler } from './accept-friend-invite-command.handler.js';

const command = {
  id: 4n,
  parentCommandId: null,
  aggregateType: 'USER_PAIR',
  aggregateKey: 'pair-key',
  commandType: 'ACCEPT_FRIEND_INVITE',
  actorUserId: 7,
  payload: { inviteId: '40' },
  progressCursor: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DomainCommand;

describe('AcceptFriendInviteCommandHandler', () => {
  it('routes the persisted command to the shared execution service', async () => {
    const dispatcher = new DomainCommandDispatcherService();
    const accept = vi.fn().mockResolvedValue(undefined);
    const handler = new AcceptFriendInviteCommandHandler(dispatcher, {
      accept,
    } as never);
    handler.onModuleInit();

    await dispatcher.execute(command);

    expect(accept).toHaveBeenCalledWith('40', 7);
  });
});
