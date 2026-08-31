import { describe, expect, it, vi } from 'vitest';
import { DomainCommandDispatcherService } from '../domain-command/domain-command-dispatcher.service.js';
import type { DomainCommand } from '../domain-command/domain-command.types.js';
import { EndFriendshipCommandHandler } from './end-friendship-command.handler.js';

const command = {
  id: 5n,
  parentCommandId: null,
  aggregateType: 'USER_PAIR',
  aggregateKey: 'pair-key',
  commandType: 'END_FRIENDSHIP',
  actorUserId: 7,
  payload: { threadId: 12, deleteData: true },
  progressCursor: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DomainCommand;

describe('EndFriendshipCommandHandler', () => {
  it('runs the existing transaction and treats network fan-out as hints', async () => {
    const dispatcher = new DomainCommandDispatcherService();
    const systemMessage = { threadId: 12, seq: 3 };
    const endP2P = vi.fn().mockResolvedValue({
      transitioned: true,
      statePeers: ['peer.test'],
      systemMessage,
      localRecipientIds: [7, 9],
    });
    const pushDiscoveryHwm = vi.fn().mockRejectedValue(new Error('offline'));
    const dispatchToUsers = vi.fn().mockRejectedValue(new Error('offline'));
    const handler = new EndFriendshipCommandHandler(
      dispatcher,
      { endP2P } as never,
      { pushDiscoveryHwm } as never,
      { dispatchToUsers } as never,
    );
    handler.onModuleInit();

    await expect(dispatcher.execute(command)).resolves.toBeUndefined();

    expect(endP2P).toHaveBeenCalledWith(12, 7, true);
    expect(pushDiscoveryHwm).toHaveBeenCalledWith('peer.test');
    expect(dispatchToUsers).toHaveBeenCalledWith(systemMessage, [7, 9]);
  });
});
