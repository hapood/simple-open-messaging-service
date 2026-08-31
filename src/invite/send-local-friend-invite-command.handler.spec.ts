import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseService } from '../database/database.service.js';
import { DomainCommandDispatcherService } from '../domain-command/domain-command-dispatcher.service.js';
import type { DomainCommand } from '../domain-command/domain-command.types.js';
import { SendLocalFriendInviteCommandHandler } from './send-local-friend-invite-command.handler.js';

function command(payload: Record<string, unknown> = {}): DomainCommand {
  return {
    id: 1n,
    parentCommandId: null,
    aggregateType: 'USER_PAIR',
    aggregateKey: 'pair-key',
    commandType: 'SEND_LOCAL_FRIEND_INVITE',
    actorUserId: 7,
    payload: { targetUserId: 9, note: 'hello', ...payload },
    progressCursor: null,
    status: 'PROCESSING',
    resultCode: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  };
}

function createHarness(options?: {
  friends?: boolean;
  identities?: Array<{
    id: number;
    availability: string;
    disabledAt: Date | null;
  }>;
}) {
  const where = vi.fn().mockResolvedValue(
    options?.identities ?? [
      { id: 7, availability: 'AVAILABLE', disabledAt: null },
      { id: 9, availability: 'AVAILABLE', disabledAt: null },
    ],
  );
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  const database = { db: { select } } as unknown as DatabaseService;
  const dispatcher = new DomainCommandDispatcherService();
  const tx = { marker: 'transaction' };
  const writeLocalFriendIntentInTx = vi
    .fn()
    .mockResolvedValue([{ userId: 7, feedId: 3 }]);
  const createFriendInvite = vi.fn(
    async (
      _from: number,
      _to: number,
      _note: string,
      _autoAccept: boolean,
      _origin: undefined,
      afterWrite: (transaction: typeof tx, created: boolean) => Promise<void>,
    ) => {
      await afterWrite(tx, true);
      return { status: 'created', inviteId: '2' } as const;
    },
  );
  const areFriends = vi.fn().mockResolvedValue(options?.friends ?? false);
  const tick = vi.fn().mockResolvedValue(undefined);
  const notifyFeedUpdates = vi.fn();
  const handler = new SendLocalFriendInviteCommandHandler(
    database,
    dispatcher,
    { createFriendInvite, writeLocalFriendIntentInTx } as never,
    { areFriends } as never,
    { tick } as never,
    { notifyFeedUpdates } as never,
  );
  handler.onModuleInit();
  return {
    dispatcher,
    handler,
    tx,
    createFriendInvite,
    writeLocalFriendIntentInTx,
    areFriends,
    tick,
    notifyFeedUpdates,
  };
}

describe('SendLocalFriendInviteCommandHandler', () => {
  it('reuses the existing invite transaction and quota callback', async () => {
    const harness = createHarness();

    await harness.dispatcher.execute(command());

    expect(harness.createFriendInvite).toHaveBeenCalledWith(
      7,
      9,
      'hello',
      true,
      undefined,
      expect.any(Function),
    );
    expect(harness.tick).toHaveBeenCalledWith(7, 'requests', harness.tx);
    expect(harness.writeLocalFriendIntentInTx).toHaveBeenCalledWith(
      harness.tx,
      7,
      9,
      true,
      'hello',
    );
    expect(harness.notifyFeedUpdates).toHaveBeenCalledWith([
      { userId: 7, feedId: 3 },
    ]);
  });

  it('treats an already-active friendship as an idempotent success', async () => {
    const harness = createHarness({ friends: true });

    await harness.dispatcher.execute(command());

    expect(harness.areFriends).toHaveBeenCalledWith(7, 9);
    expect(harness.createFriendInvite).not.toHaveBeenCalled();
  });

  it('rejects execution when the target is no longer available', async () => {
    const harness = createHarness({
      identities: [{ id: 7, availability: 'AVAILABLE', disabledAt: null }],
    });

    await expect(harness.dispatcher.execute(command())).rejects.toMatchObject({
      bizCode: 10001,
    } satisfies Partial<BusinessException>);
    expect(harness.createFriendInvite).not.toHaveBeenCalled();
  });

  it('rejects malformed persisted payloads as command invariants', async () => {
    const harness = createHarness();

    await expect(
      harness.dispatcher.execute(command({ targetUserId: '9' })),
    ).rejects.toThrow('invalid target user ID');
  });
});
