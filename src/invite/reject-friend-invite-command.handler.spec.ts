import { describe, expect, it, vi } from 'vitest';
import { DomainCommandDispatcherService } from '../domain-command/domain-command-dispatcher.service.js';
import type { DomainCommand } from '../domain-command/domain-command.types.js';
import { RejectFriendInviteCommandHandler } from './reject-friend-invite-command.handler.js';

function command(payload: Record<string, unknown> = {}): DomainCommand {
  return {
    id: 2n,
    parentCommandId: null,
    aggregateType: 'USER_PAIR',
    aggregateKey: 'pair-key',
    commandType: 'REJECT_FRIEND_INVITE',
    actorUserId: 7,
    payload: { inviteId: '41', ...payload },
    progressCursor: null,
    status: 'PROCESSING',
    resultCode: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  };
}

describe('RejectFriendInviteCommandHandler', () => {
  it('routes the persisted command to the shared execution service', async () => {
    const dispatcher = new DomainCommandDispatcherService();
    const reject = vi.fn().mockResolvedValue(undefined);
    const handler = new RejectFriendInviteCommandHandler(dispatcher, {
      reject,
    } as never);
    handler.onModuleInit();

    await dispatcher.execute(command());

    expect(reject).toHaveBeenCalledWith('41', 7);
  });

  it('rejects malformed persisted payloads', async () => {
    const dispatcher = new DomainCommandDispatcherService();
    const reject = vi.fn();
    const handler = new RejectFriendInviteCommandHandler(dispatcher, {
      reject,
    } as never);
    handler.onModuleInit();

    await expect(
      dispatcher.execute(command({ inviteId: 'not-an-id' })),
    ).rejects.toThrow('invalid invite ID');
    expect(reject).not.toHaveBeenCalled();
  });
});
