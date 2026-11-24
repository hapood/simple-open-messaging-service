import { Injectable } from '@nestjs/common';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import { resolveFederationThreadRoundTake } from './federation-thread-round.constants.js';
import { FederationThreadRoundRemoteError } from './federation-thread-round-error.js';

export interface FederationThreadForwardMessageRoundDriver {
  process(params: {
    threadId: number;
    after: number;
    through: number;
    take: number;
  }): Promise<void>;
  complete(params: {
    threadId: number;
    authorizationEpoch: number;
    targetSeq: number;
  }): Promise<void>;
}

export interface FederationThreadForwardTombstoneRoundDriver {
  process(params: {
    threadId: number;
    after: number;
    through: number;
    maxMessageSeq?: number;
    take: number;
  }): Promise<void>;
  complete(params: {
    threadId: number;
    authorizationEpoch: number;
    targetSeq: number;
  }): Promise<void>;
}

export interface FederationThreadForwardMessageRoundResult {
  targetSeq: number;
  processed: boolean;
}

export interface FederationThreadForwardTombstoneRoundResult {
  targetSeq: number;
  maxMessageSeq?: number;
  processed: boolean;
  /** More applicable facts remain in this request's cutoff. */
  hasMore?: boolean;
}

/** Freezes one bounded page for either independent forward stream. */
@Injectable()
export class FederationThreadForwardRoundService {
  constructor(private readonly states: FederationThreadSyncStateService) {}

  async runMessages(
    threadId: number,
    namespaceId: number,
    driver: FederationThreadForwardMessageRoundDriver,
    signal: AbortSignal,
    requestedTake?: number,
  ): Promise<FederationThreadForwardMessageRoundResult> {
    signal.throwIfAborted();
    const take = resolveFederationThreadRoundTake(requestedTake);
    await this.states.prepareMessageRound(threadId, namespaceId);
    signal.throwIfAborted();
    const state = await this.states.require(threadId, namespaceId);
    const targetSeq = state.messageTargetSeq;
    const processedThrough = state.messageProcessedThroughSeq;
    this.assertCoordinate(processedThrough, 'processed message seq');
    if (targetSeq <= processedThrough) return { targetSeq, processed: false };

    try {
      signal.throwIfAborted();
      await driver.process({
        threadId,
        after: processedThrough,
        through: targetSeq,
        take,
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new FederationThreadRoundRemoteError(
        error,
        state.authorizationEpoch,
      );
    }
    signal.throwIfAborted();
    await driver.complete({
      threadId,
      authorizationEpoch: state.authorizationEpoch,
      targetSeq,
    });
    return { targetSeq, processed: true };
  }

  async runTombstones(
    threadId: number,
    namespaceId: number,
    driver: FederationThreadForwardTombstoneRoundDriver,
    signal: AbortSignal,
    requestedTake?: number,
  ): Promise<FederationThreadForwardTombstoneRoundResult> {
    signal.throwIfAborted();
    const take = resolveFederationThreadRoundTake(requestedTake);
    const state = await this.states.require(threadId, namespaceId);
    const frozenTargetSeq = state.deletionTargetSeq;
    // Reservations and previous rounds are not stored messages. Read the
    // publisher coordinate from the rows that exist when building this query.
    const maxMessageSeq = await this.states.readCurrentMessageSeq(
      threadId,
      namespaceId,
    );
    signal.throwIfAborted();
    this.assertCoordinate(frozenTargetSeq, 'tombstone target seq');
    this.assertCoordinate(maxMessageSeq, 'tombstone message cutoff seq');
    const processedThrough = state.deletionProcessedThroughSeq;
    this.assertCoordinate(processedThrough, 'processed deletion seq');
    if (frozenTargetSeq <= processedThrough) {
      return {
        targetSeq: frozenTargetSeq,
        maxMessageSeq,
        processed: false,
      };
    }

    try {
      signal.throwIfAborted();
      await driver.process({
        threadId,
        after: processedThrough,
        through: frozenTargetSeq,
        maxMessageSeq,
        take,
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new FederationThreadRoundRemoteError(
        error,
        state.authorizationEpoch,
      );
    }
    signal.throwIfAborted();
    await driver.complete({
      threadId,
      authorizationEpoch: state.authorizationEpoch,
      targetSeq: frozenTargetSeq,
    });
    return {
      targetSeq: frozenTargetSeq,
      maxMessageSeq,
      processed: true,
    };
  }

  private assertCoordinate(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative safe integer`);
    }
  }
}
