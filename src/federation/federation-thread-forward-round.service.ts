import { Injectable } from '@nestjs/common';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import { resolveFederationThreadRoundTake } from './federation-thread-round.constants.js';
import { FederationThreadRoundRemoteError } from './federation-thread-round-error.js';

export interface FederationThreadForwardMessageRoundDriver {
  process(params: {
    threadId: number;
    peerDomain: string;
    after: number;
    through: number;
    take: number;
  }): Promise<void>;
  complete(params: {
    threadId: number;
    peerDomain: string;
    authorizationEpoch: number;
    targetSeq: number;
  }): Promise<void>;
}

export interface FederationThreadForwardTombstoneRoundDriver {
  process(params: {
    threadId: number;
    peerDomain: string;
    after: number;
    through: number;
    maxMessageSeq?: number;
    take: number;
  }): Promise<void>;
  complete(params: {
    threadId: number;
    peerDomain: string;
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
}

/** Freezes one bounded page for either independent forward stream. */
@Injectable()
export class FederationThreadForwardRoundService {
  constructor(private readonly states: FederationThreadSyncStateService) {}

  async runMessages(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    driver: FederationThreadForwardMessageRoundDriver,
    requestedTake?: number,
  ): Promise<FederationThreadForwardMessageRoundResult> {
    const take = resolveFederationThreadRoundTake(requestedTake);
    const state = await this.states.require(threadId);
    const targetSeq = state.messageTargetSeq;
    const processedThrough = state.messageProcessedThroughSeq;
    this.assertCoordinate(processedThrough, 'processed message seq');
    if (targetSeq <= processedThrough) return { targetSeq, processed: false };

    try {
      await driver.process({
        threadId,
        peerDomain,
        after: processedThrough,
        through: targetSeq,
        take,
      });
    } catch (error) {
      throw new FederationThreadRoundRemoteError(
        error,
        state.authorizationEpoch,
      );
    }
    await driver.complete({
      threadId,
      peerDomain,
      authorizationEpoch: state.authorizationEpoch,
      targetSeq,
    });
    return { targetSeq, processed: true };
  }

  async runTombstones(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    driver: FederationThreadForwardTombstoneRoundDriver,
    requestedTake?: number,
  ): Promise<FederationThreadForwardTombstoneRoundResult> {
    const take = resolveFederationThreadRoundTake(requestedTake);
    const state = await this.states.require(threadId);
    const recovering = state.deletionRecoveryThroughSeq !== null;
    if (recovering !== (state.deletionRecoveryMaxMessageSeq !== null))
      throw new Error('incomplete tombstone recovery state');
    const frozenTargetSeq =
      state.deletionRecoveryThroughSeq ?? state.deletionTargetSeq;
    const maxMessageSeq = state.deletionRecoveryMaxMessageSeq ?? undefined;
    this.assertCoordinate(frozenTargetSeq, 'tombstone target seq');
    if (maxMessageSeq !== undefined)
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
      await driver.process({
        threadId,
        peerDomain,
        after: processedThrough,
        through: frozenTargetSeq,
        maxMessageSeq,
        take,
      });
    } catch (error) {
      throw new FederationThreadRoundRemoteError(
        error,
        state.authorizationEpoch,
      );
    }
    await driver.complete({
      threadId,
      peerDomain,
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
