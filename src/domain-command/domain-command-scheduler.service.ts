import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { optionalIntEnv } from '../common/env.js';
import { BusinessException } from '../common/business.exception.js';
import { DomainCommandDispatcherService } from './domain-command-dispatcher.service.js';
import { DomainCommandStoreService } from './domain-command-store.service.js';
import type { DomainCommand } from './domain-command.types.js';
import { DomainCommandType } from './domain-command.constants.js';

const POLL_INTERVAL_MS = 1000;

@Injectable()
export class DomainCommandSchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(DomainCommandSchedulerService.name);
  private readonly maxConcurrency = optionalIntEnv(
    'DOMAIN_COMMAND_MAX_CONCURRENCY',
    8,
  );
  private readonly activeCommandIds = new Set<bigint>();
  private readonly activeAggregateKeys = new Set<string>();
  private pumping = false;
  private pumpRequested = false;
  private stopping = false;

  constructor(
    private readonly store: DomainCommandStoreService,
    private readonly dispatcher: DomainCommandDispatcherService,
  ) {}

  onApplicationBootstrap(): void {
    void this.wake();
  }

  onApplicationShutdown(): void {
    this.stopping = true;
  }

  @Interval(POLL_INTERVAL_MS)
  poll(): void {
    void this.wake();
  }

  wake(): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }
    this.pumpRequested = true;
    return this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopping) {
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpRequested = false;
        await this.fillAvailableSlots();
      } while (this.pumpRequested && !this.stopping);
    } catch (error) {
      this.logger.error('domain command scheduler pump failed', error);
    } finally {
      this.pumping = false;
      if (this.pumpRequested && !this.stopping) {
        void this.pump();
      }
    }
  }

  private async fillAvailableSlots(): Promise<void> {
    while (!this.stopping) {
      let available = this.maxConcurrency - this.activeCommandIds.size;
      if (available <= 0) {
        return;
      }

      const resumable = await this.store.findCheckpointedProcessing(
        DomainCommandType.DISBAND_GROUP,
        available,
      );
      for (const command of resumable) {
        if (
          this.activeCommandIds.has(command.id) ||
          this.activeAggregateKeys.has(command.aggregateKey)
        ) {
          continue;
        }
        this.start(command);
        available -= 1;
        if (available <= 0) return;
      }

      const candidates = await this.store.findEligible(
        this.dispatcher.supportedCommandTypes,
        available,
      );
      if (candidates.length === 0) {
        return;
      }

      let claimedAny = false;
      for (const candidate of candidates) {
        if (
          this.stopping ||
          this.activeCommandIds.size >= this.maxConcurrency
        ) {
          return;
        }
        if (this.activeAggregateKeys.has(candidate.aggregateKey)) {
          continue;
        }

        const claimed = await this.store.claim(candidate.id);
        if (!claimed) {
          continue;
        }
        claimedAny = true;
        this.start(claimed);
      }

      // Every candidate may have lost its conditional claim to another process. Polling will
      // reliably revisit the database; spinning here would only create claim contention.
      if (!claimedAny) {
        return;
      }
    }
  }

  private start(command: DomainCommand): void {
    this.activeCommandIds.add(command.id);
    this.activeAggregateKeys.add(command.aggregateKey);
    void this.execute(command).finally(() => {
      this.activeCommandIds.delete(command.id);
      this.activeAggregateKeys.delete(command.aggregateKey);
      void this.wake();
    });
  }

  private async execute(command: DomainCommand): Promise<void> {
    let outcome:
      | { status: 'SUCCEEDED' }
      | { status: 'REJECTED'; resultCode: number }
      | { status: 'FAILED'; lastError: string };
    try {
      await this.dispatcher.execute(command);
      outcome = { status: 'SUCCEEDED' };
    } catch (error) {
      if (error instanceof BusinessException) {
        outcome = { status: 'REJECTED', resultCode: error.bizCode };
      } else {
        outcome = {
          status: 'FAILED',
          lastError: safeUnexpectedError(error),
        };
        this.logger.error(
          `domain command ${command.id.toString()} execution failed`,
          error,
        );
      }
    }

    try {
      if (outcome.status === 'SUCCEEDED') {
        await this.store.markSucceeded(command.id);
      } else if (outcome.status === 'REJECTED') {
        await this.store.markRejected(command.id, outcome.resultCode);
      } else {
        await this.store.markFailed(command.id, outcome.lastError);
      }
    } catch (error) {
      // A lost terminal write deliberately leaves PROCESSING in place. Automatically re-executing
      // would cross the accepted crash window after the business transaction has committed.
      this.logger.error(
        `domain command ${command.id.toString()} finalization failed`,
        error,
      );
    }
  }
}

function safeUnexpectedError(error: unknown): string {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
      ? error.name
      : 'UnknownError';
  const code = readSafeErrorCode(error);
  return code
    ? `Unexpected command error (${name}, code ${code})`
    : `Unexpected command error (${name})`;
}

function readSafeErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(code)
    ? code
    : undefined;
}
