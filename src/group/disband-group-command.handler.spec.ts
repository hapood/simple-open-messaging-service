import { describe, expect, it, vi } from 'vitest';
import { DomainCommandDispatcherService } from '../domain-command/domain-command-dispatcher.service.js';
import type { DomainCommand } from '../domain-command/domain-command.types.js';
import { DisbandGroupCommandHandler } from './disband-group-command.handler.js';
import { RevokeDissolvedGroupMemberCommandHandler } from './revoke-dissolved-group-member-command.handler.js';

const parent = {
  id: 10n,
  parentCommandId: null,
  aggregateType: 'GROUP',
  aggregateKey: 'group-key',
  commandType: 'DISBAND_GROUP',
  actorUserId: 7,
  payload: { threadId: 12, deleteForUserId: 7 },
  progressCursor: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DomainCommand;

describe('group disband command handlers', () => {
  it('marks the group terminal and inserts pages until enumeration is complete', async () => {
    const dispatcher = new DomainCommandDispatcherService();
    const markGroupDissolved = vi
      .fn()
      .mockResolvedValue({ transitioned: true });
    const insertNextPage = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const handler = new DisbandGroupCommandHandler(
      dispatcher,
      { markGroupDissolved } as never,
      { insertNextPage } as never,
    );
    handler.onModuleInit();

    await dispatcher.execute(parent);

    expect(markGroupDissolved).toHaveBeenCalledWith({
      threadId: 12,
      operatorUserId: 7,
    });
    expect(insertNextPage).toHaveBeenCalledTimes(3);
    expect(insertNextPage).toHaveBeenCalledWith(parent, 12, 7);
  });

  it('routes a parent-linked child to one member revoke transaction', async () => {
    const dispatcher = new DomainCommandDispatcherService();
    const revokeDissolvedGroupMember = vi.fn().mockResolvedValue(undefined);
    const handler = new RevokeDissolvedGroupMemberCommandHandler(dispatcher, {
      revokeDissolvedGroupMember,
    } as never);
    handler.onModuleInit();
    const child = {
      ...parent,
      id: 11n,
      parentCommandId: 10n,
      commandType: 'REVOKE_DISSOLVED_GROUP_MEMBER',
      payload: { threadId: 12, memberUserId: 9, deleteData: false },
    } satisfies DomainCommand;

    await dispatcher.execute(child);

    expect(revokeDissolvedGroupMember).toHaveBeenCalledWith({
      threadId: 12,
      memberUserId: 9,
      deleteData: false,
    });
  });
});
