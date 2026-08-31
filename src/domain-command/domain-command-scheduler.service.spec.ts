import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business.exception.js';
import { DomainCommandDispatcherService } from './domain-command-dispatcher.service.js';
import { DomainCommandSchedulerService } from './domain-command-scheduler.service.js';
import type { DomainCommandStoreService } from './domain-command-store.service.js';
import type { DomainCommand } from './domain-command.types.js';

function makeCommand(id: bigint, aggregateKey = `aggregate-${id.toString()}`) {
  return {
    id,
    parentCommandId: null,
    aggregateType: 'GROUP',
    aggregateKey,
    commandType: 'TEST_COMMAND',
    actorUserId: 1,
    payload: {},
    progressCursor: null,
    status: 'PENDING',
    resultCode: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
  } satisfies DomainCommand;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createStore(commands: DomainCommand[]) {
  const findCheckpointedProcessing = vi.fn(
    async (commandType: string, limit: number) =>
      commands
        .filter(
          ({ status, commandType: candidateType }) =>
            status === 'PROCESSING' && candidateType === commandType,
        )
        .slice(0, limit),
  );
  const findEligible = vi.fn(async (_types: readonly string[], limit: number) =>
    commands.filter(({ status }) => status === 'PENDING').slice(0, limit),
  );
  const claim = vi.fn(async (id: bigint) => {
    const command = commands.find((candidate) => candidate.id === id);
    if (!command || command.status !== 'PENDING') return undefined;
    command.status = 'PROCESSING';
    command.startedAt = new Date();
    return command;
  });
  const markSucceeded = vi.fn(async (id: bigint) => {
    commands.find((command) => command.id === id)!.status = 'SUCCEEDED';
  });
  const markRejected = vi.fn(async (id: bigint) => {
    commands.find((command) => command.id === id)!.status = 'REJECTED';
  });
  const markFailed = vi.fn(async (id: bigint) => {
    commands.find((command) => command.id === id)!.status = 'FAILED';
  });
  return {
    store: {
      findCheckpointedProcessing,
      findEligible,
      claim,
      markSucceeded,
      markRejected,
      markFailed,
    } as unknown as DomainCommandStoreService,
    markSucceeded,
    markRejected,
    markFailed,
  };
}

const savedConcurrency = process.env.DOMAIN_COMMAND_MAX_CONCURRENCY;

afterEach(() => {
  vi.restoreAllMocks();
  if (savedConcurrency === undefined) {
    delete process.env.DOMAIN_COMMAND_MAX_CONCURRENCY;
  } else {
    process.env.DOMAIN_COMMAND_MAX_CONCURRENCY = savedConcurrency;
  }
});

describe('DomainCommandSchedulerService', () => {
  it('resumes only checkpointed disband commands already in processing', async () => {
    const command = {
      ...makeCommand(1n, 'group-key'),
      commandType: 'DISBAND_GROUP',
      status: 'PROCESSING',
      startedAt: new Date(),
    } satisfies DomainCommand;
    const harness = createStore([command]);
    const dispatcher = new DomainCommandDispatcherService();
    const execute = vi.fn().mockResolvedValue(undefined);
    dispatcher.register({ commandType: 'DISBAND_GROUP', execute });
    const scheduler = new DomainCommandSchedulerService(
      harness.store,
      dispatcher,
    );

    await scheduler.wake();
    await vi.waitFor(() =>
      expect(harness.markSucceeded).toHaveBeenCalledWith(1n),
    );

    expect(execute).toHaveBeenCalledWith(command);
  });

  it('bounds unrelated command execution and refills released slots', async () => {
    process.env.DOMAIN_COMMAND_MAX_CONCURRENCY = '2';
    const commands = [makeCommand(1n), makeCommand(2n), makeCommand(3n)];
    const harness = createStore(commands);
    const dispatcher = new DomainCommandDispatcherService();
    const gates = new Map(commands.map(({ id }) => [id, deferred()]));
    const execute = vi.fn(
      (command: DomainCommand) => gates.get(command.id)!.promise,
    );
    dispatcher.register({ commandType: 'TEST_COMMAND', execute });
    const scheduler = new DomainCommandSchedulerService(
      harness.store,
      dispatcher,
    );

    await scheduler.wake();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(commands.map(({ status }) => status)).toEqual([
      'PROCESSING',
      'PROCESSING',
      'PENDING',
    ]);

    gates.get(1n)!.resolve();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(commands[2].status).toBe('PROCESSING');

    gates.get(2n)!.resolve();
    gates.get(3n)!.resolve();
    await vi.waitFor(() =>
      expect(harness.markSucceeded).toHaveBeenCalledTimes(3),
    );
  });

  it('maps business refusals and sanitized unexpected failures to terminal states', async () => {
    const commands = [makeCommand(1n), makeCommand(2n), makeCommand(3n)];
    const harness = createStore(commands);
    const dispatcher = new DomainCommandDispatcherService();
    dispatcher.register({
      commandType: 'TEST_COMMAND',
      execute: async ({ id }) => {
        if (id === 2n) {
          throw new BusinessException(20010, 'invite missing');
        }
        if (id === 3n) {
          throw Object.assign(new Error('secret remote response'), {
            code: 'ECONNRESET',
          });
        }
      },
    });
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const scheduler = new DomainCommandSchedulerService(
      harness.store,
      dispatcher,
    );

    await scheduler.wake();
    await vi.waitFor(() => expect(harness.markFailed).toHaveBeenCalledOnce());
    expect(harness.markSucceeded).toHaveBeenCalledWith(1n);
    expect(harness.markRejected).toHaveBeenCalledWith(2n, 20010);
    expect(harness.markFailed).toHaveBeenCalledWith(
      3n,
      'Unexpected command error (Error, code ECONNRESET)',
    );
    expect(harness.markFailed.mock.calls[0][1]).not.toContain('secret');
  });
});
