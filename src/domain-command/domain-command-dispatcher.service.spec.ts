import { describe, expect, it, vi } from 'vitest';
import { DomainCommandDispatcherService } from './domain-command-dispatcher.service.js';
import type { DomainCommand } from './domain-command.types.js';

const command = {
  id: 1n,
  parentCommandId: null,
  aggregateType: 'GROUP',
  aggregateKey: 'group-key',
  commandType: 'DISBAND_GROUP',
  actorUserId: 1,
  payload: {},
  progressCursor: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DomainCommand;

describe('DomainCommandDispatcherService', () => {
  it('registers, executes, and unregisters a handler', async () => {
    const dispatcher = new DomainCommandDispatcherService();
    const execute = vi.fn(async () => undefined);
    const unregister = dispatcher.register({
      commandType: 'DISBAND_GROUP',
      execute,
    });

    expect(dispatcher.supportedCommandTypes).toEqual(['DISBAND_GROUP']);
    await dispatcher.execute(command);
    expect(execute).toHaveBeenCalledWith(command);

    unregister();
    expect(dispatcher.supportedCommandTypes).toEqual([]);
    await expect(dispatcher.execute(command)).rejects.toThrow(
      'no handler registered',
    );
  });

  it('rejects invalid and duplicate registrations', () => {
    const dispatcher = new DomainCommandDispatcherService();
    const handler = {
      commandType: 'DISBAND_GROUP',
      execute: async () => undefined,
    };
    dispatcher.register(handler);

    expect(() => dispatcher.register(handler)).toThrow('already registered');
    expect(() =>
      dispatcher.register({ ...handler, commandType: 'disband-group' }),
    ).toThrow(TypeError);
  });
});
