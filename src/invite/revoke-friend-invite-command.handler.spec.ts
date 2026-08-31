import { describe, expect, it, vi } from 'vitest';
import { DomainCommandDispatcherService } from '../domain-command/domain-command-dispatcher.service.js';
import type { DomainCommand } from '../domain-command/domain-command.types.js';
import { RevokeFriendInviteCommandHandler } from './revoke-friend-invite-command.handler.js';

const command = {
  id: 3n,
  parentCommandId: null,
  aggregateType: 'USER_PAIR',
  aggregateKey: 'pair-key',
  commandType: 'REVOKE_FRIEND_INVITE',
  actorUserId: 7,
  payload: { inviteId: '42' },
  progressCursor: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DomainCommand;

describe('RevokeFriendInviteCommandHandler', () => {
  it('routes the persisted command to the shared execution service', async () => {
    const dispatcher = new DomainCommandDispatcherService();
    const revoke = vi.fn().mockResolvedValue(undefined);
    const handler = new RevokeFriendInviteCommandHandler(dispatcher, {
      revoke,
    } as never);
    handler.onModuleInit();

    await dispatcher.execute(command);

    expect(revoke).toHaveBeenCalledWith('42', 7);
  });
});
